/** Bounded, read-only remote project resources. Trust decisions belong to the Coop host, never to remote settings. */
import { posix } from "node:path";
import type { Context } from "@earendil-works/chord";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { clampThinkingLevel, type ModelThinkingLevel } from "@earendil-works/pi-ai";
import { parseFrontmatter, type ModelRuntime, type Skill } from "@earendil-works/pi-coding-agent";
import { getOrThrow, type ExecutionEnv, type FileInfo } from "@earendil-works/pi-durable/env";
import { HttpError } from "./errors.ts";
import { isThinkingLevel } from "./models.ts";
import type { PromptTemplate } from "./prompts.ts";
import type { ProjectTrust, TrustChoice } from "./skills.ts";

/** Additive host configuration, keyed by the exact filesystem identity and canonical remote folder. */
export type RemoteProjectTrustDecision = { filesystem: string; path: string; trusted: boolean };
export type RemoteProjectSkill = Skill & { content: string };
/** A transport's native descriptor-checked read. SFTP v3 cannot promise no-follow opens. */
export type RemoteProjectFileReader = (path: string, boundary: string) => Promise<Uint8Array>;
export type RemoteProjectResourceSet = {
    trust: ProjectTrust;
    skills: RemoteProjectSkill[];
    templates: PromptTemplate[];
};

const MAX_BYTES = 50 * 1024;
const MAX_TOTAL_BYTES = 1024 * 1024;
const MAX_ENTRIES = 4096;
const MAX_DEPTH = 16;
const MAX_ANCESTORS = 100;

function inside(base: string, path: string): boolean {
    const relative = posix.relative(base, path);

    return relative !== ".." && !relative.startsWith("../") && !posix.isAbsolute(relative);
}

function absolute(path: string): string {
    if (!posix.isAbsolute(path) || path.includes("\0") || posix.normalize(path) !== path) {
        throw new Error("Remote resources require canonical absolute POSIX paths.");
    }

    return path;
}

async function canonical(env: ExecutionEnv, path: string, context: Context): Promise<string> {
    return absolute(getOrThrow(await env.canonicalPath(path, context)));
}

function savedDecision(
    filesystem: string,
    folder: string,
    decisions: readonly RemoteProjectTrustDecision[],
): ProjectTrust["saved"] {
    let saved: ProjectTrust["saved"] = null;

    for (const entry of decisions) {
        if (
            typeof entry.filesystem !== "string" ||
            typeof entry.path !== "string" ||
            typeof entry.trusted !== "boolean"
        ) {
            throw new Error("The host's remote project trust choices cannot be read.");
        }

        absolute(entry.path);

        if (
            entry.filesystem === filesystem &&
            inside(entry.path, folder) &&
            (saved === null || entry.path.length >= saved.path.length)
        ) {
            saved = { path: entry.path, trusted: entry.trusted };
        }
    }

    return saved;
}

/** One bounded lookup: directory pages, file handles and byte totals are all limited independently. */
class Lookup {
    readonly env: ExecutionEnv;
    readonly context: Context;
    readonly openedRead?: RemoteProjectFileReader;
    bytes = 0;
    entries = 0;
    constructor(env: ExecutionEnv, context: Context, openedRead?: RemoteProjectFileReader) {
        this.env = env;
        this.context = context;
        this.openedRead = openedRead;
    }

    async info(path: string): Promise<FileInfo | undefined> {
        const result = await this.env.fileInfo(path, this.context);

        if (
            !result.ok &&
            (result.error.code === "not_found" || result.error.code === "not_directory")
        ) {
            return undefined;
        }

        return getOrThrow(result);
    }

    async confined(path: string, boundary: string): Promise<string> {
        const resolved = await canonical(this.env, path, this.context);

        if (!inside(boundary, resolved)) {
            throw new Error(`Remote project resource escapes its discovery folder: ${path}`);
        }

        return resolved;
    }

    async text(path: string, boundary: string): Promise<string> {
        const resolved = await this.confined(path, boundary);
        let bytes: Uint8Array;

        if (this.openedRead !== undefined) {
            bytes = await this.openedRead(resolved, boundary);
        } else {
            const reader = getOrThrow(
                await this.env.openBinaryReader(resolved, { noFollow: true }, this.context),
            );

            try {
                bytes = getOrThrow(await reader.read(0, MAX_BYTES + 1, this.context));
            } finally {
                await reader.close(BACKGROUND_CONTEXT);
            }
        }

        this.bytes += bytes.byteLength;

        if (bytes.byteLength > MAX_BYTES || this.bytes > MAX_TOTAL_BYTES) {
            throw new Error(`Remote project resources exceed the size limit: ${path}`);
        }

        const text = new TextDecoder("utf-8", { fatal: true }).decode(bytes);

        if (text.includes("\0")) {
            throw new Error(`Remote project resources must be UTF-8 text: ${path}`);
        }

        return text;
    }

    async directory(path: string): Promise<FileInfo[]> {
        const reader = getOrThrow(await this.env.openDirReader(path, this.context));
        const found: FileInfo[] = [];

        try {
            for (;;) {
                const page = getOrThrow(await reader.next(128, this.context));

                this.entries += page.entries.length;

                if (this.entries > MAX_ENTRIES) {
                    throw new Error("Remote project resource discovery exceeds 4096 entries.");
                }

                for (const entry of page.entries) {
                    if (
                        entry.name === "" ||
                        entry.name === "." ||
                        entry.name === ".." ||
                        entry.name.includes("/") ||
                        entry.name.includes("\0")
                    ) {
                        throw new Error("Invalid remote project resource directory entry.");
                    }
                }

                found.push(...page.entries);

                if (page.done) {
                    return found.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
                }

                if (page.entries.length === 0) {
                    throw new Error("Remote project resource directory reader made no progress.");
                }
            }
        } finally {
            await reader.close(BACKGROUND_CONTEXT);
        }
    }

    async skills(folder: string, boundary: string): Promise<RemoteProjectSkill[]> {
        if ((await this.info(folder))?.kind !== "directory") {
            return [];
        }

        const root = await this.confined(folder, boundary);
        const visited = new Set<string>();
        const found: RemoteProjectSkill[] = [];

        const skill = async (filePath: string) => {
            const content = await this.text(filePath, root);
            let frontmatter: Record<string, unknown>;

            try {
                ({ frontmatter } = parseFrontmatter(content));
            } catch {
                return;
            }

            if (
                typeof frontmatter.description !== "string" ||
                frontmatter.description.trim() === ""
            ) {
                return;
            }

            const baseDir = posix.dirname(filePath);
            const name =
                typeof frontmatter.name === "string" && frontmatter.name !== ""
                    ? frontmatter.name
                    : posix.basename(baseDir);

            found.push({
                name,
                description: frontmatter.description,
                filePath,
                baseDir,
                content,
                disableModelInvocation: frontmatter["disable-model-invocation"] === true,
                sourceInfo: {
                    path: filePath,
                    source: this.env.id,
                    scope: "project",
                    origin: "top-level",
                    baseDir,
                },
            });
        };

        const walk = async (path: string, depth: number) => {
            if (depth > MAX_DEPTH) {
                throw new Error("Remote skill discovery exceeds 16 nested folders.");
            }

            const resolved = await this.confined(path, root);

            if (visited.has(resolved)) {
                return;
            }

            visited.add(resolved);
            const entries = await this.directory(resolved);
            const declared = entries.find((entry) => entry.name === "SKILL.md");

            if (declared !== undefined) {
                const path = posix.join(resolved, declared.name);

                if ((await this.info(path))?.kind === "file") {
                    await skill(path);

                    return;
                }
            }

            for (const entry of entries) {
                if (entry.name.startsWith(".") || entry.name === "node_modules") {
                    continue;
                }

                const path = posix.join(resolved, entry.name);
                const kind = entry.kind === "symlink" ? (await this.info(path))?.kind : entry.kind;

                if (kind === "directory") {
                    await walk(path, depth + 1);
                } else if (kind === "file" && depth === 0 && entry.name.endsWith(".md")) {
                    await skill(path);
                }
            }
        };

        await walk(root, 0);

        return found;
    }

    async templates(folder: string, boundary: string): Promise<PromptTemplate[]> {
        if ((await this.info(folder))?.kind !== "directory") {
            return [];
        }

        const root = await this.confined(folder, boundary);
        const found: PromptTemplate[] = [];

        for (const entry of await this.directory(root)) {
            if (!entry.name.endsWith(".md")) {
                continue;
            }

            const path = posix.join(root, entry.name);

            if ((await this.info(path))?.kind !== "file") {
                continue;
            }

            const text = await this.text(path, root);
            let frontmatter: Record<string, unknown>;
            let body: string;

            try {
                ({ frontmatter, body } = parseFrontmatter(text));
            } catch {
                continue;
            }

            const first = body.split("\n").find((line) => line.trim() !== "") ?? "";
            const description =
                typeof frontmatter.description === "string" && frontmatter.description !== ""
                    ? frontmatter.description
                    : first.length > 60
                      ? `${first.slice(0, 60)}...`
                      : first;
            const hint = frontmatter["argument-hint"];

            found.push({
                name: entry.name.replace(/\.md$/, ""),
                description,
                ...(typeof hint === "string" ? { argumentHint: hint } : {}),
                path,
                content: body,
            });
        }

        return found;
    }
}

/**
 * No host filesystem access, shell execution, remote settings import or automatic trust. Discovery follows Pi's
 * SKILL.md roots, direct Markdown children, hidden/node_modules exclusion, nearest ancestor precedence and git-root
 * boundary, with explicit file/tree budgets. Unlike Pi's local loader it does not apply .gitignore, .ignore or
 * .fdignore patterns, import extra project resource paths or treat remote home resources as host-global resources.
 */
export class RemoteProjectResources {
    async load(
        env: ExecutionEnv,
        cwd: string,
        decisions: readonly RemoteProjectTrustDecision[],
        context: Context,
        openedRead?: RemoteProjectFileReader,
    ): Promise<RemoteProjectResourceSet> {
        const folder = await canonical(env, cwd, context);
        const parent = posix.dirname(folder);
        const saved = savedDecision(env.id, folder, decisions);
        const lookup = new Lookup(env, context, openedRead);
        const ancestors: string[] = [];

        for (let current = folder; ; current = posix.dirname(current)) {
            ancestors.push(current);

            if (
                (await lookup.info(posix.join(current, ".git"))) !== undefined ||
                posix.dirname(current) === current
            ) {
                break;
            }

            if (ancestors.length >= MAX_ANCESTORS) {
                throw new Error("Remote resource lookup exceeds 100 ancestor folders.");
            }
        }

        const remoteHome = await canonical(env, "~", context);
        const own = await lookup.skills(posix.join(folder, ".pi", "skills"), folder);
        const folders: string[] = [];
        const inherited: RemoteProjectSkill[] = [];

        for (const ancestor of ancestors) {
            // A remote account's home-global resources are not Coop's host-global resources.
            if (ancestor === remoteHome) {
                continue;
            }

            const path = posix.join(ancestor, ".agents", "skills");

            if ((await lookup.info(path))?.kind === "directory") {
                folders.push(path);
                inherited.push(...(await lookup.skills(path, ancestor)));
            }
        }

        const templates = await lookup.templates(posix.join(folder, ".pi", "prompts"), folder);
        const settings =
            (await lookup.info(posix.join(folder, ".pi", "settings.json"))) !== undefined;
        const trusted = saved?.trusted === true;
        const unique = [...own, ...inherited].filter(
            (skill, index, all) => all.findIndex((each) => each.name === skill.name) === index,
        );
        const describe = (skills: RemoteProjectSkill[]) =>
            skills.map(({ name, description }) => ({ name, description }));

        return {
            trust: {
                folder,
                ...(parent === folder ? {} : { parent }),
                saved,
                defaultProjectTrust: "ask",
                trusted,
                folders,
                skills: describe(inherited),
                ownSkills: describe(own),
                settings,
                ask: saved === null && (unique.length > 0 || templates.length > 0 || settings),
            },
            skills: trusted ? unique : [],
            templates: trusted ? templates : [],
        };
    }

    /** The caller authenticates the owner and persists this replacement on the host before publishing it. */
    async saveTrust(
        env: ExecutionEnv,
        cwd: string,
        decisions: readonly RemoteProjectTrustDecision[],
        choice: TrustChoice,
        context: Context,
    ): Promise<RemoteProjectTrustDecision[]> {
        const folder = await canonical(env, cwd, context);

        savedDecision(env.id, folder, decisions);

        if (choice !== "trust" && choice !== "trust-parent" && choice !== "distrust") {
            throw new HttpError(400, "Unknown project trust choice.");
        }

        const path = choice === "trust-parent" ? posix.dirname(folder) : folder;

        if (choice === "trust-parent" && path === folder) {
            throw new HttpError(400, "This folder has no folder above it.");
        }

        return [
            ...decisions.filter(
                (entry) =>
                    entry.filesystem !== env.id || (entry.path !== path && entry.path !== folder),
            ),
            { filesystem: env.id, path, trusted: choice !== "distrust" },
        ];
    }

    /** Read a registered remote skill's relative resource; no arbitrary paths or host-global resource substitution. */
    async readSkill(
        env: ExecutionEnv,
        cwd: string,
        decisions: readonly RemoteProjectTrustDecision[],
        name: string,
        resource: string | undefined,
        context: Context,
    ): Promise<string> {
        if (resource !== undefined && (posix.isAbsolute(resource) || resource.includes("\0"))) {
            throw new Error(
                "A remote skill resource must be a relative path inside its skill directory.",
            );
        }

        const loaded = await this.load(env, cwd, decisions, context);
        const skill = loaded.skills.find((each) => each.name === name);

        if (skill === undefined) {
            throw new Error(
                `No trusted remote project skill is registered as ${JSON.stringify(name)}.`,
            );
        }

        if (resource === undefined) {
            return skill.content;
        }

        const path = posix.resolve(skill.baseDir, resource);

        if (!inside(skill.baseDir, path)) {
            throw new Error("A remote skill resource must remain inside its skill directory.");
        }

        return new Lookup(env, context).text(path, skill.baseDir);
    }

    /** Creation-time model defaults only. All other settings, credentials and execution policy stay on Coop. */
    async modelDefault(
        env: ExecutionEnv,
        cwd: string,
        decisions: readonly RemoteProjectTrustDecision[],
        models: ModelRuntime,
        context: Context,
        openedRead?: RemoteProjectFileReader,
    ) {
        const folder = await canonical(env, cwd, context);

        if (savedDecision(env.id, folder, decisions)?.trusted !== true) {
            return undefined;
        }

        const lookup = new Lookup(env, context, openedRead);
        const path = posix.join(folder, ".pi", "settings.json");

        if ((await lookup.info(path)) === undefined) {
            return undefined;
        }

        const fail = (detail: string): never => {
            throw new HttpError(
                400,
                `SSH project .pi/settings.json: ${detail} No session was created.`,
            );
        };

        let value: unknown;

        try {
            value = JSON.parse((await lookup.text(path, folder)).replace(/^\uFEFF/, ""));
        } catch {
            return fail("Cannot read bounded UTF-8 JSON. Check the file and connection.");
        }

        if (value === null || typeof value !== "object" || Array.isArray(value)) {
            return fail("Expected a JSON object.");
        }

        const {
            defaultProvider: provider,
            defaultModel: id,
            defaultThinkingLevel: thinking,
        } = value as {
            defaultProvider?: unknown;
            defaultModel?: unknown;
            defaultThinkingLevel?: unknown;
        };

        if (
            thinking !== undefined &&
            (typeof thinking !== "string" || !isThinkingLevel(thinking))
        ) {
            return fail(
                "Invalid defaultThinkingLevel. Use off, minimal, low, medium, high, xhigh, or max.",
            );
        }

        if (provider === undefined && id === undefined) {
            return undefined;
        }

        if (
            typeof provider !== "string" ||
            provider.trim() === "" ||
            typeof id !== "string" ||
            id.trim() === ""
        ) {
            return fail("Set both defaultProvider and defaultModel to non-empty strings.");
        }

        const model = models.getModel(provider, id);

        if (model === undefined) {
            return fail(
                "The provider or model is not known. Check defaultProvider and defaultModel.",
            );
        }

        return {
            model,
            thinkingLevel: clampThinkingLevel(model, (thinking ?? "off") as ModelThinkingLevel),
        };
    }
}
