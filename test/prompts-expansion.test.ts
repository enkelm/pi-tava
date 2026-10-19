import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { test } from "node:test";
import {
    expandPromptTemplate,
    expandSkillCommand,
    loadPromptTemplates,
    unwrapSkill,
    type SkillCommand,
} from "../src/server/prompts.ts";

// These public expansion boundaries own source selection and cross-namespace precedence. Loader trust/bounds have
// their own tests; these regressions fail when a correct remote snapshot is mistakenly reopened as a host filename.
test("skill expansion consumes SSH content rather than a host-local namesake and fails closed without that content", async () => {
    const root = await mkdtemp(join(tmpdir(), "coop-skill-expansion-"));

    try {
        const path = join(root, 'skill "雪"', "SKILL.md");

        await mkdir(dirname(path), { recursive: true });
        await writeFile(path, "---\nname: guide\ndescription: Host namesake\n---\nHOST_TRAP");
        const command: SkillCommand = {
            source: "ssh",
            name: "guide",
            description: "Remote guide",
            path,
            baseDir: dirname(path),
            content: "---\nname: guide\ndescription: Remote guide\n---\nRemote instructions.\n",
        };
        const expanded = expandSkillCommand("/skill:guide Inspect src/auth.ts", [command]);

        assert.ok(expanded);
        assert.match(expanded, /Remote instructions\./);
        assert.doesNotMatch(expanded, /HOST_TRAP|description:/);
        assert.match(expanded, /&quot;雪&quot;/);
        assert.equal(unwrapSkill(expanded), "Remote instructions.\n\nInspect src/auth.ts");
        assert.match(
            expandSkillCommand("/skill:guide", [
                { ...command, source: "host", content: undefined },
            ])!,
            /HOST_TRAP/,
        );
        const missing = { ...command, content: undefined } as unknown as SkillCommand;

        assert.throws(
            () => expandSkillCommand("/skill:guide", [missing]),
            /SSH skill content is unavailable; no host-local file was substituted/,
        );
        assert.equal(expandSkillCommand("/skill:unknown", [command]), undefined);
        assert.equal(expandSkillCommand("ordinary request", [command]), undefined);
    } finally {
        await rm(root, { recursive: true, force: true });
    }
});

test("trusted remote templates retain global-project-extra precedence without host project discovery", async () => {
    const root = await mkdtemp(join(tmpdir(), "coop-template-expansion-"));

    try {
        const agentDir = join(root, "agent");
        const cwd = join(root, "host-namesake");
        const extra = join(root, "extra");

        const put = async (path: string, content: string) => {
            await mkdir(dirname(path), { recursive: true });
            await writeFile(path, content);
        };

        await put(join(agentDir, "prompts", "global.md"), "Global $1");
        await put(join(cwd, ".pi", "prompts", "trap.md"), "HOST_PROJECT_TRAP");
        await put(join(extra, "global.md"), "Wrong extra global");
        await put(join(extra, "remote.md"), "Wrong extra remote");
        await put(join(extra, "extra.md"), "Extra $@");
        const templates = loadPromptTemplates(cwd, agentDir, [extra], {
            project: false,
            projectTemplates: [
                {
                    name: "global",
                    description: "shadowed",
                    path: "/ssh/project/global.md",
                    content: "Wrong remote global",
                },
                {
                    name: "remote",
                    description: "remote",
                    path: "/ssh/project/remote.md",
                    content: "Remote $1 | $2",
                },
            ],
        });

        assert.deepEqual(
            templates.map((template) => template.name),
            ["global", "remote", "extra"],
        );
        assert.equal(expandPromptTemplate("/global selected", templates), "Global selected");
        assert.equal(
            expandPromptTemplate('/remote "with spaces" 雪', templates),
            "Remote with spaces | 雪",
        );
        assert.equal(expandPromptTemplate("/extra one two", templates), "Extra one two");
        assert.doesNotMatch(JSON.stringify(templates), /HOST_PROJECT_TRAP/);
        assert.equal(expandPromptTemplate("/trap", templates), undefined);
    } finally {
        await rm(root, { recursive: true, force: true });
    }
});
