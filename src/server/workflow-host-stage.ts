/** Bounded Git snapshots cross SSH; external acquisition/publication and credentials stay on the Coop host. */
import { isUtf8 } from "node:buffer";
import { createHash } from "node:crypto";
import { mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { delimiter, isAbsolute, join } from "node:path";
import type { Context } from "@earendil-works/chord";
import { getOrThrow } from "@earendil-works/pi-durable/env";
import type { ConversationId } from "@earendil-works/pi-durable";
import type { WorkspaceBackend } from "./workspace-backend.ts";
import { safeWorkflowGit } from "./workflow-policy.ts";

/** Injected by the host; must retain the invocation's live requester and native confinement. */
export type WorkflowBackendFactory = (
    id: ConversationId,
    context: Context,
) => WorkspaceBackend | Promise<WorkspaceBackend>;

export const GH_VALUES = new Set([
    "--title",
    "-t",
    "--body",
    "-b",
    "--body-file",
    "-F",
    "--repo",
    "-R",
    "--base",
    "-B",
    "--head",
    "-H",
    "--assignee",
    "-a",
    "--reviewer",
    "-r",
    "--label",
    "-l",
    "--milestone",
    "-m",
    "--project",
    "-p",
    "--add-assignee",
    "--remove-assignee",
    "--add-reviewer",
    "--remove-reviewer",
    "--add-label",
    "--remove-label",
    "--add-project",
    "--remove-project",
    "--state",
    "--search",
    "--limit",
    "--author",
    "--reason",
    "--match-head-commit",
    "--json",
]);

const MAX_BUNDLE = 32 * 1024 * 1024;
const MAX_MANIFEST = 1024 * 1024;
const MAX_REFS = 4096;
const MAX_BODY = 8 * 1024 * 1024;
const OID = /^[0-9a-f]{40}(?:[0-9a-f]{24})?$/;

function isolatedGitEnvironment(): NodeJS.ProcessEnv {
    const env: NodeJS.ProcessEnv = {};

    for (const key of Object.keys(process.env)) {
        if (key.startsWith("GIT_")) {
            env[key] = undefined;
        }
    }

    return {
        ...env,
        GIT_CONFIG_GLOBAL: "/dev/null",
        GIT_CONFIG_SYSTEM: "/dev/null",
        GIT_CONFIG_NOSYSTEM: "1",
    };
}

function hostStageGit(
    cwd: string,
    args: readonly string[],
    context: Context,
    options: Parameters<typeof safeWorkflowGit>[3] = {},
) {
    return safeWorkflowGit(cwd, args, context, {
        ...options,
        env: { ...isolatedGitEnvironment(), ...options.env },
    });
}

function utf8(bytes: Buffer, label: string): string {
    if (!isUtf8(bytes)) {
        throw new Error(`Non-UTF-8 ${label} is unsupported.`);
    }

    return bytes.toString("utf8");
}

async function git(backend: WorkspaceBackend, args: string[], readOnly = true): Promise<Buffer> {
    return backend.gitBytes(backend.cwd, args, {
        offline: true,
        readOnly,
        maxBuffer: MAX_MANIFEST,
        timeoutMs: 120_000,
    });
}

function manifest(bytes: Buffer): { oid: string; ref: string }[] {
    const lines = utf8(bytes, "Git ref manifest").split("\n").filter(Boolean);

    if (lines.length > MAX_REFS) {
        throw new Error(`SSH Git transfer supports at most ${MAX_REFS} refs.`);
    }

    const seen = new Set<string>();

    return lines.sort().map((line) => {
        const [oid, ref, extra] = line.split(" ");

        if (
            !OID.test(oid ?? "") ||
            !ref?.startsWith("refs/heads/") ||
            extra !== undefined ||
            seen.has(ref)
        ) {
            throw new Error("Invalid or duplicate ref in SSH Git transfer manifest.");
        }

        seen.add(ref);

        return { oid: oid!, ref };
    });
}

async function hostBundle(path: string): Promise<Buffer> {
    const info = await stat(path);

    if (!info.isFile() || info.size > MAX_BUNDLE) {
        throw new Error(`SSH Git bundle exceeds ${MAX_BUNDLE} bytes.`);
    }

    const bytes = await readFile(path);

    if (bytes.length !== info.size || bytes.length > MAX_BUNDLE) {
        throw new Error("SSH Git bundle changed or exceeded its byte limit.");
    }

    return bytes;
}

/** A remote file URL belongs to that remote filesystem, not a same-named file on the host. */
export function requireHostTransport(url: string): void {
    if (
        !/^(https:\/\/|ssh:\/\/)/.test(url) &&
        !/^[A-Za-z0-9_][A-Za-z0-9_.-]*@[A-Za-z0-9][A-Za-z0-9_.-]*:[A-Za-z0-9_./~-]+$/.test(url)
    ) {
        throw new Error(
            "SSH workspace external Git operations require an ordinary HTTPS or SSH URL. Remote local-file URLs cannot be acquired or published on the host.",
        );
    }

    if (/[\0\r\n]/.test(url) || url.includes("::")) {
        throw new Error(
            "Custom or multiline SSH workspace external Git transports are unsupported.",
        );
    }

    if (/^(https:\/\/|ssh:\/\/)/.test(url)) {
        const parsed = new URL(url);

        if (
            !parsed.hostname ||
            parsed.password ||
            parsed.search ||
            parsed.hash ||
            (parsed.protocol === "https:" && parsed.username)
        ) {
            throw new Error(
                "SSH workspace external Git URLs must not embed credentials, queries or fragments.",
            );
        }
    }
}

/** The only inbound payload is a capped bundle and an explicit, checked ref manifest. */
export async function importHostFetch(
    backend: WorkspaceBackend,
    stage: string,
    remote: string,
    context: Context,
): Promise<void> {
    const refs = manifest(
        await hostStageGit(
            stage,
            ["for-each-ref", "--format=%(objectname) %(refname)", "refs/heads/"],
            context,
            { maxBytes: MAX_MANIFEST },
        ),
    );

    if (refs.length === 0) {
        return;
    }

    const manifestBytes = Buffer.from(JSON.stringify(refs));

    if (manifestBytes.length > MAX_MANIFEST) {
        throw new Error("SSH ref manifest exceeds its byte limit; no refs were imported.");
    }

    const bundle = join(stage, "inbound.bundle");

    await hostStageGit(stage, ["bundle", "create", bundle, "--branches"], context, {
        readOnly: false,
        timeoutMs: 120_000,
    });
    const bytes = await hostBundle(bundle);
    const directory = getOrThrow(await backend.env.createTempDir("pi-pull-", context));
    const remoteBundle = backend.paths.join(directory, "inbound.bundle");
    const remoteManifest = backend.paths.join(directory, "refs.json");

    try {
        getOrThrow(await backend.env.writeFile(remoteBundle, bytes, context));
        getOrThrow(await backend.env.writeFile(remoteManifest, manifestBytes, context));

        if (!(await backend.readBytes(remoteManifest, MAX_MANIFEST)).equals(manifestBytes)) {
            throw new Error("Transferred ref manifest changed; no tracking refs were imported.");
        }

        const actual = manifest(await git(backend, ["bundle", "list-heads", remoteBundle]));

        if (JSON.stringify(actual) !== JSON.stringify(refs)) {
            throw new Error(
                "Transferred bundle ref manifest changed; no tracking refs were imported.",
            );
        }

        for (const { ref } of refs) {
            const destination = `refs/remotes/${remote}/${ref.slice("refs/heads/".length)}`;
            const symbolic = await backend.gitBytes(
                backend.cwd,
                ["symbolic-ref", "--quiet", "--no-recurse", destination],
                { offline: true, readOnly: true, allowExit: [1], maxBuffer: MAX_MANIFEST },
            );

            if (symbolic.length > 0) {
                throw new Error(
                    `Pull will not import into symbolic tracking ref ${destination}; checkout refs were not imported.`,
                );
            }
        }

        const effective = utf8(
            await git(backend, ["ls-remote", "--get-url", remoteBundle]),
            "bundle URL",
        ).replace(/\n$/, "");

        if (effective !== remoteBundle) {
            throw new Error(
                "The staging import URL would be rewritten by checkout configuration; refs were not imported.",
            );
        }

        await git(
            backend,
            [
                "-c",
                "core.hooksPath=/dev/null",
                "-c",
                "protocol.allow=never",
                "-c",
                "protocol.file.allow=always",
                "-c",
                "gc.auto=0",
                "fetch",
                "--no-tags",
                "--no-recurse-submodules",
                "--no-auto-maintenance",
                "--",
                remoteBundle,
                ...refs.map(
                    ({ ref }) =>
                        `+${ref}:refs/remotes/${remote}/${ref.slice("refs/heads/".length)}`,
                ),
            ],
            false,
        );
    } finally {
        // Only remove the two names we created. Never recursively erase unknown remote content.
        await backend.env.remove(remoteBundle, { force: true }, context);
        await backend.env.remove(remoteManifest, { force: true }, context);
        await backend.env.remove(directory, { force: true }, context);
    }
}

const SAFE_CONFIG =
    /^(?:core\.(?:repositoryformatversion|filemode|bare|logallrefupdates|ignorecase|precomposeunicode|worktree)|user\.(?:name|email)|init\.defaultbranch|remote\.[^.]+\.(?:url|pushurl|fetch)|branch\..+\.(?:remote|merge)|extensions\.objectformat)$/;

/** Staging does not reproduce remote hooks or arbitrary executable configuration on the online host. */
export async function publicationRemoteInputs(backend: WorkspaceBackend): Promise<string> {
    const config = await git(backend, ["config", "--null", "--list"]);
    const hash = createHash("sha256").update(backend.id).update(backend.cwd).update(config);

    for (const entry of utf8(config, "Git configuration").split("\0").filter(Boolean)) {
        const key = entry.split("\n", 1)[0]!;

        if (!SAFE_CONFIG.test(key)) {
            throw new Error(
                `SSH host-side publication cannot preserve Git configuration '${key}'. Remove it or publish manually; no approval or external operation was started.`,
            );
        }
    }

    const hooks = utf8(
        await git(backend, ["rev-parse", "--git-path", "hooks"]),
        "Git hooks path",
    ).replace(/\n$/, "");
    const hooksPath = await backend.absolute(hooks);

    if (await backend.exists(hooksPath)) {
        const directory = getOrThrow(await backend.env.openDirReader(hooksPath, backend.context));

        try {
            let count = 0;
            let hookBytes = 0;

            for (;;) {
                const page = getOrThrow(await directory.next(64, backend.context));

                for (const entry of page.entries) {
                    if (++count > 256) {
                        throw new Error(
                            "Too many remote Git hooks for bounded publication inspection.",
                        );
                    }

                    if (entry.name.endsWith(".sample")) {
                        continue;
                    }

                    const path = backend.paths.join(hooksPath, entry.name);
                    const info = await backend.lstat(path);

                    if (info.kind !== "file" || (info.mode & 0o111) !== 0) {
                        throw new Error(
                            `SSH host-side publication cannot safely execute remote Git hook '${entry.name}'. Publish manually or remove the active hook before requesting approval.`,
                        );
                    }

                    if (info.size > MAX_BODY - hookBytes) {
                        throw new Error("Remote Git hook inspection exceeds its total byte limit.");
                    }

                    const bytes = await backend.readBytes(path, MAX_BODY - hookBytes);

                    hookBytes += bytes.length;
                    hash.update(entry.name).update(bytes);
                }

                if (page.done) {
                    break;
                }
            }
        } finally {
            await directory.close(backend.context);
        }
    }

    return hash.digest("hex");
}

export type HostPublicationAuth = {
    entries: { key: string; value: string }[];
    fingerprint: string;
};

/** Only host-owned credential configuration is admitted; host URL rewrites/hooks never enter staging. */
export async function hostPublicationAuth(context: Context): Promise<HostPublicationAuth> {
    const directory = await mkdtemp(join(tmpdir(), "pi-publication-auth-"));

    try {
        const env: NodeJS.ProcessEnv = {};

        for (const key of Object.keys(process.env)) {
            if (key.startsWith("GIT_")) {
                env[key] = undefined;
            }
        }

        const config = await safeWorkflowGit(directory, ["config", "--null", "--list"], context, {
            env,
            maxBytes: MAX_MANIFEST,
        });
        const entries: HostPublicationAuth["entries"] = [];

        for (const entry of utf8(config, "host credential configuration")
            .split("\0")
            .filter(Boolean)) {
            const at = entry.indexOf("\n");
            const key = at < 0 ? entry : entry.slice(0, at);
            const value = at < 0 ? "" : entry.slice(at + 1);

            if (/^credential(?:\..+)?\.(?:helper|username|usehttppath)$/.test(key)) {
                entries.push({ key, value });
            }
        }

        return {
            entries,
            fingerprint: createHash("sha256").update(JSON.stringify(entries)).digest("hex"),
        };
    } finally {
        await rm(directory, { recursive: true, force: true });
    }
}

export type PublicationBody = {
    index: number;
    path: string;
    bytes: Buffer;
    sha256: string;
    inline: boolean;
    flag: string;
};

/** Preserve body-file bytes and source-path binding; do not reinterpret remote filenames on the host. */
export async function publicationBodies(
    backend: WorkspaceBackend,
    command: readonly string[],
): Promise<PublicationBody[]> {
    const bodies: PublicationBody[] = [];

    if (command[0] !== "gh") {
        return bodies;
    }

    for (let index = 3; index < command.length; index++) {
        const [flag, inline] = command[index]!.split(/=(.*)/s);

        if (!GH_VALUES.has(flag!)) {
            continue;
        }

        const value = inline ?? command[++index];

        if (flag !== "--body-file" && flag !== "-F") {
            continue;
        }

        if (value === undefined || value === "-" || value.includes("\0")) {
            throw new Error(
                "Publication body files require one explicit bounded source file; stdin is unsupported.",
            );
        }

        if (bodies.length !== 0) {
            throw new Error("Publication accepts only one explicit body-file input.");
        }

        const path = await backend.canonical(value);
        const info = await backend.lstat(path);

        if (info.kind !== "file" || info.size > MAX_BODY) {
            throw new Error("Publication body file must be a bounded regular file.");
        }

        const bytes = await backend.readBytes(path, MAX_BODY);

        utf8(bytes, "publication body file");
        bodies.push({
            index,
            path,
            bytes,
            sha256: createHash("sha256").update(bytes).digest("hex"),
            inline: inline !== undefined,
            flag: flag!,
        });
    }

    return bodies;
}

/** Host authentication is selected here; never copy these values into the SSH environment. */
export function hostExternalEnvironment(): Record<string, string> {
    const env: Record<string, string> = {
        PATH: (process.env.PATH ?? "/usr/bin:/bin")
            .split(delimiter)
            .filter(isAbsolute)
            .join(delimiter),
        GIT_CONFIG_NOSYSTEM: "1",
        GIT_CONFIG_GLOBAL: "/dev/null",
        GIT_CONFIG_SYSTEM: "/dev/null",
        GIT_TERMINAL_PROMPT: "0",
        GIT_NO_LAZY_FETCH: "1",
        GH_HOST: "github.com",
        GH_PROMPT_DISABLED: "1",
        GH_PAGER: "/bin/cat",
        PAGER: "/bin/cat",
        NO_COLOR: "1",
    };

    for (const key of [
        "HOME",
        "TMPDIR",
        "SSH_AUTH_SOCK",
        "GH_TOKEN",
        "GITHUB_TOKEN",
        "GH_CONFIG_DIR",
        "HTTPS_PROXY",
        "HTTP_PROXY",
        "NO_PROXY",
    ]) {
        if (process.env[key] !== undefined) {
            env[key] = process.env[key]!;
        }
    }

    return env;
}

/** Snapshot body files even for local publication; approvals bind bytes, not a later path lookup. */
export async function stagePublicationBodies(
    command: readonly string[],
    bodies: readonly PublicationBody[],
): Promise<{ command: string[]; cleanup(): Promise<void> }> {
    const stage = await mkdtemp(join(tmpdir(), "pi-publication-bodies-"));

    try {
        const pinned = [...command];

        for (let i = 0; i < bodies.length; i++) {
            const body = bodies[i]!;
            const path = join(stage, `body-${i}.txt`);

            await writeFile(path, body.bytes, { mode: 0o600 });
            pinned[body.index] = body.inline ? `${body.flag}=${path}` : path;
        }

        return { command: pinned, cleanup: () => rm(stage, { recursive: true, force: true }) };
    } catch (error) {
        await rm(stage, { recursive: true, force: true });

        throw error;
    }
}

/** Export a pinned remote commit OFFLINE; only an app-created bare snapshot is ever online. */
export async function stagePublication(
    backend: WorkspaceBackend,
    head: string,
    command: readonly string[],
    bodies: readonly PublicationBody[],
    context: Context,
    auth?: HostPublicationAuth,
): Promise<{ cwd: string; command: string[]; cleanup(): Promise<void> }> {
    if (!OID.test(head)) {
        throw new Error("Publication snapshot requires a concrete commit.");
    }

    const stage = await mkdtemp(join(tmpdir(), "pi-publication-"));
    let remoteDirectory: string | undefined;

    try {
        remoteDirectory = getOrThrow(await backend.env.createTempDir("pi-publish-", context));
        const remoteBundle = backend.paths.join(remoteDirectory, "snapshot.bundle");

        // HEAD was pinned and rechecked by the caller under the work-item lock. Git bundle create
        // accepts commit IDs but only named refs become bundle heads; HEAD is verified again below.
        await git(backend, ["bundle", "create", remoteBundle, "HEAD"], false);
        const bytes = await backend.readBytes(remoteBundle, MAX_BUNDLE);
        const bundle = join(stage, "snapshot.bundle");

        await writeFile(bundle, bytes, { mode: 0o600 });
        await hostStageGit(
            stage,
            [
                "init",
                "--bare",
                "--template=",
                ...(head.length === 64 ? ["--object-format=sha256"] : []),
                ".",
            ],
            context,
            {
                readOnly: false,
                env: { GIT_CONFIG_GLOBAL: "/dev/null", GIT_CONFIG_SYSTEM: "/dev/null" },
            },
        );
        const heads = utf8(
            await hostStageGit(stage, ["bundle", "list-heads", bundle], context, {
                maxBytes: MAX_MANIFEST,
            }),
            "snapshot bundle heads",
        );

        if (heads !== `${head} HEAD\n`) {
            throw new Error("Exported publication commit changed; no external operation ran.");
        }

        await hostStageGit(
            stage,
            [
                "-c",
                "core.hooksPath=/dev/null",
                "-c",
                "protocol.allow=never",
                "-c",
                "protocol.file.allow=always",
                "fetch",
                "--no-tags",
                "--no-recurse-submodules",
                "--",
                bundle,
                `${head}:refs/heads/publish`,
            ],
            context,
            {
                readOnly: false,
                timeoutMs: 120_000,
                env: { GIT_CONFIG_GLOBAL: "/dev/null", GIT_CONFIG_SYSTEM: "/dev/null" },
            },
        );

        for (const { key, value } of auth?.entries ?? []) {
            await hostStageGit(stage, ["config", "--local", "--add", key, value], context, {
                readOnly: false,
                env: { GIT_CONFIG_GLOBAL: "/dev/null", GIT_CONFIG_SYSTEM: "/dev/null" },
            });
        }

        const executionCommand = [...command];

        if (command[0] === "gh" && command[1] === "pr" && command[2] === "create") {
            for (let i = 3; i < command.length; i++) {
                const [flag, inline] = command[i]!.split(/=(.*)/s);

                if (!GH_VALUES.has(flag!)) {
                    continue;
                }

                const value = inline ?? command[++i]!;

                if (flag === "--head" || flag === "-H") {
                    const branch = value;

                    await hostStageGit(
                        stage,
                        ["update-ref", `refs/heads/${branch}`, head],
                        context,
                        {
                            readOnly: false,
                            env: { GIT_CONFIG_GLOBAL: "/dev/null", GIT_CONFIG_SYSTEM: "/dev/null" },
                        },
                    );
                    await hostStageGit(
                        stage,
                        ["symbolic-ref", "HEAD", `refs/heads/${branch}`],
                        context,
                        { readOnly: false },
                    );
                }

                if (flag === "--repo" || flag === "-R") {
                    const repository = value.replace(/^github\.com\//, "");

                    if (!/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(repository)) {
                        throw new Error(
                            "Publication staging requires an explicit GitHub repository.",
                        );
                    }

                    await hostStageGit(
                        stage,
                        ["remote", "add", "origin", `https://github.com/${repository}.git`],
                        context,
                        { readOnly: false },
                    );
                }
            }
        }

        for (let i = 0; i < bodies.length; i++) {
            const body = bodies[i]!;
            const path = join(stage, `body-${i}.txt`);

            await writeFile(path, body.bytes, { mode: 0o600 });
            executionCommand[body.index] = body.inline ? `${body.flag}=${path}` : path;
        }

        return {
            cwd: stage,
            command: executionCommand,
            cleanup: () => rm(stage, { recursive: true, force: true }),
        };
    } catch (error) {
        await rm(stage, { recursive: true, force: true });

        throw error;
    } finally {
        if (remoteDirectory !== undefined) {
            await backend.env.remove(
                backend.paths.join(remoteDirectory, "snapshot.bundle"),
                { force: true },
                context,
            );
            await backend.env.remove(remoteDirectory, { force: true }, context);
        }
    }
}
