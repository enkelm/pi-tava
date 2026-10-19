/**
 * The system prompt: who the agent is, how to behave on a phone-sized screen, where Pi Coop's documentation is, the
 * project's AGENTS.md files, Pi's skills, and the working directory. Sections render before every request; only
 * changed sections are sent again, so everything here is stable between requests unless a file on disk changed.
 *
 * Edit freely: saving this file reloads it into the running server.
 */
import { statSync } from "node:fs";
import { join, resolve } from "node:path";
import {
    formatSkillsForPrompt,
    getDocsPath,
    loadProjectContextFiles,
} from "@earendil-works/pi-coding-agent";
import { Type } from "@earendil-works/pi-ai";
import { defineExtension, defineTool, type PromptInput, section } from "@earendil-works/pi-durable";
import { APP_ROOT } from "../config.ts";
import type { PocketHost } from "../host.ts";
import {
    hostInstructions,
    readHostSkill,
    RemoteContext,
    type ContextFile,
} from "../remote-context.ts";

const PREAMBLE = `You are Pi, a coding agent running inside Pi Coop: a durable, multiplayer web app built on Pi Durable. People talk to you from a browser, often a phone, and several people can share one conversation. When more than one person uses this server, each message starts with [from: Name].

You work in the conversation's working directory with the tools you are given. Your work is durable: if the server restarts, you continue where you left off. A tool call cut off by a restart comes back as an "interrupted" error when it was not safe to repeat; check what actually happened before you retry it.`;

const GUIDELINES = `- Keep replies short and easy to read on a small screen. Lead with the answer; use short paragraphs, lists, and small code blocks.
- Use read to look at files instead of cat or sed. Use edit for precise changes and write for new files or full rewrites.
- Show file paths clearly when you work with files.
- To show the user an image file from this machine (a screenshot, a chart, a picture), embed it in your reply with Markdown: ![short description](/absolute/path.png). Paths relative to the working directory work too. Files the user attaches are saved on the server; their paths are listed in the message.
- Before running something destructive or irreversible, say what it will do. A guard may ask a human to approve risky commands; if a call is blocked, do not try to get around the block.
- Do not commit, push, publish, or deploy unless asked.`;

/**
 * Where Pi Coop's documentation for agents is, as Pi's prompt says where Pi's is: to read only when it is
 * needed.
 */
function docs(dataDir: string): string {
    const code = resolve(APP_ROOT);
    const folder = join(code, "docs");

    return `Pi Coop documentation (read only when someone asks about Pi Coop itself: how it works, changing how you behave in it, extending it, or changing its code):
- Start here: ${join(folder, "index.md")}
- Pi Coop's code is in ${code}; its data (people, settings, sessions) in ${dataDir}. Change the data through the app, never by editing its files, except extensions/ in it, where drop-in extensions go.
- When asked about: changing how you behave without code, such as instructions, AGENTS.md, skills, or prompt templates (docs/customizing.md); a new tool, prompt section, hook, page, button, or route (docs/extensions.md, with guides in docs/extensions/, working examples in docs/examples/ and exact types in types/pocket.d.ts); themes (docs/extensions/themes.md and docs/extensions/reference/theme-surface.md); changing Pi Coop's own code while it runs (docs/self-editing.md); where its code is (docs/map.md); how its parts depend on each other (docs/architecture.md); what a feature does (docs/features.md)
- Resolve docs/... and types/... under ${code}, not the working directory. Read a doc completely, and follow its relevant links, before changing anything.
- Pi's own documentation (skills, prompt templates, models, providers, settings): ${getDocsPath()}`;
}

const STALE_MS = 30_000;

type Resources = {
    at: number;
    trust: number;
    context: string | undefined;
    skills: string | undefined;
};

export default function createPrompt(host: PocketHost) {
    // Bind while installing: an older live host must reject this replacement, not install render closures that fail.
    const projectResources = host.projectResources.bind(host);

    // Context files and skills load once per directory, and again when the copy is older than STALE_MS, or Pi's trust
    // store changed since: a project trusted now has skills it did not have, from the next request on. Only answers to
    // "trust this project?" show at once; other changes (a new skill, Pi's defaultProjectTrust) wait for STALE_MS, or
    // a request more (the app reads Pi's settings again in the background as often).
    const resources = new Map<string, Resources>();
    const remoteContext = new RemoteContext();
    const renderFiles = (files: ContextFile[]) =>
        files
            .map(
                (file) =>
                    `<file path="${host.text.defang(file.path).replaceAll("&", "&amp;").replaceAll('"', "&quot;")}">\n${host.text.defang(file.content.trim())}\n</file>`,
            )
            .join("\n\n");
    const remoteOf = (input: PromptInput) => host.workspace(input.conversationId);
    const hostSkill = defineTool({
        name: "host_skill",
        description:
            "Read a registered host-global skill or a relative text resource inside it. For SSH threads only; this reads on the Coop host, not the SSH machine. Never executes or stages scripts. Maximum 50KB per resource and 2000 lines per reply.",
        parameters: Type.Object({
            name: Type.String({ description: "Registered host-global skill name" }),
            resource: Type.Optional(
                Type.String({
                    description: "Resource path relative to the skill directory; omit for SKILL.md",
                }),
            ),
            offset: Type.Optional(Type.Integer({ minimum: 1 })),
            limit: Type.Optional(Type.Integer({ minimum: 1, maximum: 2000 })),
        }),
        replay: "safe",
        execute: async (args, api) => {
            if (host.workspace(api.conversationId).location?.kind !== "ssh") {
                throw new Error("host_skill is for SSH workspaces; use read for local skills.");
            }

            const text = await readHostSkill(
                host.globalSkills(),
                args.name,
                args.resource,
                args.offset,
                args.limit,
            );

            return {
                content: [
                    {
                        type: "text",
                        text: `Host-global skill resource (not a remote file):\n${text}`,
                    },
                ],
            };
        },
    });

    const trustChanged = () => {
        try {
            return statSync(join(host.agentDir, "trust.json")).mtimeMs;
        } catch {
            return 0;
        }
    };

    const load = (cwd: string): Resources => {
        const cached = resources.get(cwd);
        const trust = trustChanged();

        if (cached !== undefined && Date.now() - cached.at < STALE_MS && cached.trust === trust) {
            return cached;
        }

        let context: string | undefined;
        let skills: string | undefined;

        try {
            const files = loadProjectContextFiles({ cwd, agentDir: host.agentDir });

            if (files.length > 0) {
                context = files
                    .map((file) => `<file path="${file.path}">\n${file.content.trim()}\n</file>`)
                    .join("\n\n");
            }
        } catch (error) {
            host.notice("warning", `Could not load AGENTS.md files for ${cwd}: ${String(error)}`);
        }

        try {
            const text = formatSkillsForPrompt(host.skills(cwd), "read").trim();

            skills = text === "" ? undefined : text;
        } catch (error) {
            host.notice("warning", `Could not load skills for ${cwd}: ${String(error)}`);
        }

        const fresh = { at: Date.now(), trust, context, skills };

        resources.set(cwd, fresh);

        return fresh;
    };

    const cwdOf = (input: PromptInput) => input.env?.cwd ?? input.agent.cwd ?? process.cwd();

    return defineExtension({
        name: "pocket-prompt",
        tools: [hostSkill],
        sections: [
            section("preamble", () => PREAMBLE, { tag: false }),
            section("guidelines", (input) =>
                remoteOf(input).location?.kind === "ssh"
                    ? `${GUIDELINES}\n- In this SSH thread, attached files and inline image URLs are host-local. Before a remote script needs an attachment, call stage_upload(path) with its host upload path and use the returned remote temporary path. It copies one attached file from this thread's upload directory; the source remains on the host. Do not automatically replay an uncertain stage_upload. It does not stage host scripts or global skill resources. Do not treat remote image paths as host attachments; remote-generated image attachment handling is unsupported in this first slice.`
                    : GUIDELINES,
            ),
            section("pocket_docs", (input) =>
                remoteOf(input).location?.kind === "ssh"
                    ? "Pi Coop and provider configuration live on the Coop host, not this SSH machine. Remote read/bash cannot directly access host documentation or uploads. Use stage_upload(path) to copy an attached file to the remote before a remote script needs it; the original remains host-local. Host scripts and global skill resources cannot be staged by this tool. Use a local thread for host app documentation. Do not copy provider credentials or whole host settings directories to the remote."
                    : docs(host.dataDir),
            ),
            section("project_context", async (input, context) => {
                const workspace = remoteOf(input);

                if (workspace.location?.kind !== "ssh") {
                    return load(cwdOf(input)).context;
                }

                const blocks: string[] = [];

                try {
                    const global = renderFiles(await hostInstructions(host.agentDir));

                    if (global !== "") {
                        blocks.push(`Host-global instructions:\n${global}`);
                    }
                } catch (error) {
                    blocks.push(
                        `Host-global instructions unavailable: ${host.text.defang(String(error))}`,
                    );
                }

                try {
                    blocks.push(
                        renderFiles(await remoteContext.load(workspace.env, cwdOf(input), context)),
                    );
                } catch (error) {
                    blocks.push(
                        `SSH project instructions unavailable: ${host.text.defang(String(error))}. No local project context was substituted. Retry on a later request after fixing the connection.`,
                    );
                }

                return blocks.filter(Boolean).join("\n\n");
            }),
            section(
                "skills",
                async (input, context) => {
                    const workspace = remoteOf(input);

                    if (workspace.location?.kind !== "ssh") {
                        return load(cwdOf(input)).skills;
                    }

                    const blocks: string[] = [];
                    let global: ReturnType<PocketHost["globalSkills"]> = [];
                    let remote: ReturnType<PocketHost["globalSkills"]> = [];

                    try {
                        // Deliberately independent of SSH discovery: connection loss cannot hide host-global skills.
                        global = host.globalSkills();
                    } catch (error) {
                        blocks.push(
                            `Host-global skills unavailable: ${host.text.defang(String(error))}`,
                        );
                    }

                    try {
                        const loaded = await projectResources(input.conversationId, context);

                        remote = loaded.skills.filter(
                            (skill) =>
                                skill.sourceInfo.source === workspace.env.id &&
                                skill.sourceInfo.scope === "project",
                        );
                    } catch (error) {
                        blocks.push(
                            `SSH project skills unavailable: ${host.text.defang(String(error))}. No host-local project namesakes were substituted. Host-global skills below remain host resources, not replacement project resources. Retry after fixing the connection.`,
                        );
                    }

                    const text = formatSkillsForPrompt(remote, "read").trim();

                    if (text !== "") {
                        blocks.push(
                            `Trusted remote project skills (paths are on this SSH machine):\n${text}`,
                        );
                    }

                    // Remote project names win, including skills that allow only explicit slash invocation.
                    const remoteNames = new Set(remote.map((skill) => skill.name));
                    const visibleGlobal = global.filter(
                        (skill) => !skill.disableModelInvocation && !remoteNames.has(skill.name),
                    );

                    blocks.push(
                        `Host-global skills: read them with host_skill(name), and relative resources with host_skill(name, resource). Their paths are on the Coop host, not the remote; never pass host paths to remote read/bash. Host skill scripts cannot be run or staged remotely by host_skill.\n\n${visibleGlobal.map((skill) => `- ${host.text.defang(skill.name)}: ${host.text.defang(skill.description)}`).join("\n")}`,
                    );

                    return blocks.join("\n\n");
                },
                { tag: false },
            ),
            section("environment", (input) => {
                // The date only, so the prompt stays cache-friendly through the day.
                const today = new Date().toISOString().slice(0, 10);

                const workspace = remoteOf(input);

                if (workspace.location?.kind === "ssh") {
                    return `Working directory: ${cwdOf(input)}\nLocation: SSH · ${host.text.defang(workspace.location.host)}\nPlatform: remote POSIX; bash required (remote OS not detected).\nAll agents, subagents, model calls and history run on the Coop host. Files and bash target this one SSH workspace; host paths are not remote paths. No local fallback or automatic replay of uncertain remote mutations.\nToday: ${today}`;
                }

                return `Working directory: ${cwdOf(input)}\nPlatform: ${process.platform}\nToday: ${today}`;
            }),
        ],
    });
}
