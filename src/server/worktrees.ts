/**
 * A session can work in a git worktree of its own: a checkout of the same repository, on a branch of its own, in
 * Pi Pocket's data folder. Its changes stay apart from the folder it came from and from other sessions, and a fork in
 * a worktree tries another approach without touching the first. A worktree starts with the folder's files as they
 * are: the last commit, uncommitted changes, and new files. Ignored files, such as node_modules, are not copied.
 */
import { randomUUID } from "node:crypto";
import { getOrThrow } from "@earendil-works/pi-durable/env";
import { existsSync, realpathSync } from "node:fs";
import { relative, resolve, sep } from "node:path";
import { describe, HttpError } from "./errors.ts";
import { git, GitError, type GitOptions } from "./git.ts";
import { isMissingWorkspaceFile, WorkspaceBackend } from "./workspace-backend.ts";

/** Re-evaluated for every child process, including failed-creation cleanup. */
export type WorktreePolicy = Pick<GitOptions, "offline" | "backend">;

export type Worktree = {
    /** The worktree's folder. */
    path: string;
    branch: string;
    /** The folder the session came from, where it goes back to when the worktree is removed. */
    source: string;
    /** Additive namespace identity. Legacy worktrees are host-local. */
    destination?: string;
};

/** How many bytes of new files a new worktree gets, all together; any file that would go past it is left out. */
const MAX_COPIED_BYTES = 50 * 1024 * 1024;

/** A persistent worktree folder on the selected destination, never a host-data path interpreted remotely. */
export async function worktreeStorage(
    backend: WorkspaceBackend,
    localFolder: string,
    policy: WorktreePolicy = {},
): Promise<string> {
    if (!backend.remote) {
        return localFolder;
    }

    const home = await backend.canonical("~");
    const folder = backend.paths.join(home, ".pi-coop-worktrees");
    let missing = false;

    try {
        await backend.lstat(folder);
    } catch (error) {
        if (!isMissingWorkspaceFile(error)) {
            throw error;
        }

        missing = true;
    }

    if (missing) {
        // No -p or chmod: a pre-existing path is never followed or made more permissive.
        const result = getOrThrow(
            await backend.exec(["mkdir", "-m", "700", folder], { timeout: 15 }, policy, false),
        );

        if (result.exitCode !== 0) {
            // Another request may have created it. Inspect only; never replay a mutation.
            const current = await backend.lstat(folder);

            if (current.kind !== "directory") {
                throw new HttpError(409, "Remote worktree storage could not be created.");
            }
        }
    }

    const info = await backend.lstat(folder);

    if (
        info.kind !== "directory" ||
        (info.mode & 0o777) !== 0o700 ||
        (await backend.canonical(folder)) !== folder
    ) {
        throw new HttpError(
            409,
            "Remote worktree storage must be a private 0700 directory, not a symlink. Choose or repair it explicitly; permissions were not changed.",
        );
    }

    return folder;
}

/** The top folder of the repository `cwd` is in, or undefined when it is in none. */
async function repositoryOf(cwd: string, policy: WorktreePolicy): Promise<string | undefined> {
    return git(cwd, ["rev-parse", "--show-toplevel"], policy).then(
        (root) => root.replace(/\n$/, ""),
        (error: unknown) => {
            if (
                policy.backend?.remote &&
                (!(error instanceof GitError) || error.exitCode !== 128)
            ) {
                throw error;
            }

            return undefined;
        },
    );
}

/** Plan the same untracked-file budget for copying and pre-copy source inspection; no file bytes are read. */
export async function planWorktreeCopy(
    root: string,
    policy: WorktreePolicy,
    maxPaths = Infinity,
): Promise<{ files: { path: string; size: number }[]; skipped: string[] }> {
    const backend = policy.backend ?? WorkspaceBackend.local(root);
    const { join } = backend.paths;
    const paths = (
        await git(root, ["ls-files", "--others", "--exclude-standard", "-z"], policy)
    ).split("\0");

    if (paths.filter((path) => path !== "").length > maxPaths) {
        throw new HttpError(409, "Code exceeds the worktree inspection path limit.");
    }

    const files: { path: string; size: number }[] = [];
    const skipped: string[] = [];
    let copied = 0;

    for (const path of paths) {
        if (path === "") {
            continue;
        }

        const from = join(root, path);
        const stats = await backend.lstat(from).catch((error: unknown) => {
            if (isMissingWorkspaceFile(error)) {
                return undefined;
            }

            throw error;
        });

        if (stats === undefined || stats.kind !== "file") {
            continue;
        }

        if (copied + stats.size > MAX_COPIED_BYTES) {
            skipped.push(path);
            continue;
        }

        files.push({ path, size: stats.size });
        copied += stats.size;
    }

    return { files, skipped };
}

/** Copy the repository's new (untracked, not ignored) files into the worktree. Returns the ones left out for size. */
async function copyNewFiles(root: string, into: string, policy: WorktreePolicy): Promise<string[]> {
    const backend = policy.backend ?? WorkspaceBackend.local(root);
    const { join } = backend.paths;
    const { files, skipped } = await planWorktreeCopy(root, policy);
    let copied = 0;

    for (const { path, size } of files) {
        await backend.copyFile(
            join(root, path),
            join(into, path),
            MAX_COPIED_BYTES - copied,
            policy,
        );
        copied += size;
    }

    return skipped;
}

/** Reserve stable coordinates before a durable caller starts any Git mutation. No worktree is created here. */
export async function planWorktree(
    cwd: string,
    folder: string,
    label: string,
    policy: WorktreePolicy = {},
    identity?: string,
): Promise<Worktree> {
    const backend = policy.backend ?? WorkspaceBackend.local(cwd);
    const slug =
        label
            .toLowerCase()
            .replace(/[^a-z0-9]+/g, "-")
            .replace(/^-+|-+$/g, "")
            .slice(0, 40) || "session";

    if (identity !== undefined && !/^[0-9a-f]{64}$/.test(identity)) {
        throw new HttpError(400, "A durable worktree identity must be a SHA-256 request key.");
    }

    const name = `${slug}-${identity?.slice(0, 32) ?? randomUUID().slice(0, 6)}`;

    return {
        path: backend.paths.join(await backend.absolute(folder), name),
        branch: `pocket/${name}`,
        source: cwd,
        ...(backend.remote ? { destination: backend.id } : {}),
    };
}

/**
 * Make a worktree for a session that works in `cwd`, under `folder`, named after `label`. Returns it, the folder
 * inside it that matches `cwd`, and the new files too big to copy. Durable callers can supply reserved coordinates;
 * failed reserved setups are retained for reconciliation, never force-deleted or silently retried.
 */
export async function createWorktree(
    cwd: string,
    folder: string,
    label: string,
    policy: WorktreePolicy = {},
    reserved?: Worktree,
): Promise<{ worktree: Worktree; cwd: string; skipped: string[] }> {
    const backend = policy.backend ?? WorkspaceBackend.local(cwd);
    const { resolve } = backend.paths;
    const root = await repositoryOf(cwd, policy);

    if (root === undefined) {
        throw new HttpError(
            400,
            `${cwd} is not in a git repository, so it cannot have a worktree.`,
        );
    }

    // Where `cwd` is within the repository, as git sees it: `cwd` may be reached through a symbolic link, `root` not.
    const within = (await git(cwd, ["rev-parse", "--show-prefix"], policy)).replace(/\n$/, "");

    if (
        !(await git(root, ["rev-parse", "--verify", "--quiet", "HEAD"], policy).then(
            () => true,
            () => false,
        ))
    ) {
        throw new HttpError(400, "The repository has no commits yet: commit once, then try again.");
    }

    const worktree = reserved ?? (await planWorktree(cwd, folder, label, policy));

    requireWorktreeDestination(worktree, backend);

    if (
        worktree.source !== cwd ||
        backend.paths.dirname(worktree.path) !== (await backend.absolute(folder)) ||
        worktree.branch !== `pocket/${backend.paths.basename(worktree.path)}`
    ) {
        throw new HttpError(409, "The reserved worktree does not match this source or storage.");
    }

    await backend.mkdir(folder);
    await git(root, ["worktree", "add", "-b", worktree.branch, worktree.path, "HEAD"], {
        ...policy,
        readOnly: false,
    });

    try {
        // Uncommitted changes to tracked files, as a commit object that changes nothing here; empty when there are none.
        const changes = (
            await git(root, ["stash", "create"], { ...policy, readOnly: false })
        ).trim();

        if (changes !== "") {
            await git(worktree.path, ["stash", "apply", changes], { ...policy, readOnly: false });
        }

        const skipped = await copyNewFiles(root, worktree.path, policy);

        backend.checkAccess(true);

        return { worktree, cwd: resolve(worktree.path, within), skipped };
    } catch (error) {
        if (reserved === undefined) {
            await discardWorktree(worktree, policy).catch(() => undefined);
        }

        throw new HttpError(500, `The worktree could not be set up: ${describe(error)}`);
    }
}

/** Whether a folder is the worktree's or one inside it, also when reached through a symbolic link. */
export function inWorktree(worktree: Worktree, cwd: string): boolean {
    if (worktree.destination !== undefined) {
        throw new HttpError(409, "Use destination-aware containment for remote worktrees.");
    }

    const real = (path: string) => {
        try {
            return realpathSync(path);
        } catch {
            return resolve(path);
        }
    };

    const base = real(worktree.path);
    const folder = real(cwd);

    return folder === base || folder.startsWith(base + sep);
}

/**
 * Where each folder of a worktree is in the folder it was made from: the same place in the repository, and the
 * session's folder as it was given. A folder that is only in the worktree maps to the session's folder.
 */
export async function sourceFolders(
    worktree: Worktree,
    policy: WorktreePolicy = {},
): Promise<(cwd: string) => string> {
    if (policy.backend?.remote || worktree.destination !== undefined) {
        throw new HttpError(409, "Use sourceFolder for destination-aware remote worktree mapping.");
    }

    const root = await repositoryOf(worktree.source, policy);
    let original: string | undefined;

    try {
        original = realpathSync(worktree.source);
    } catch {
        original = undefined;
    }

    return (cwd) => {
        if (root === undefined) {
            return worktree.source;
        }

        const mapped = resolve(root, relative(worktree.path, cwd));

        return mapped === original || !existsSync(mapped) ? worktree.source : mapped;
    };
}

/**
 * Remove a worktree's folder; its branch stays, with whatever was committed on it. One with uncommitted changes is
 * kept, unless `force`.
 */
export async function removeWorktree(
    worktree: Worktree,
    force: boolean,
    policy: WorktreePolicy = {},
): Promise<void> {
    const backend = policy.backend ?? WorkspaceBackend.local(worktree.source);

    requireWorktreeDestination(worktree, backend);

    if (!(await backend.exists(worktree.path))) {
        return;
    }

    const root = await repositoryOf(worktree.source, policy);

    if (root === undefined) {
        throw new HttpError(409, `${worktree.source} is not in a git repository anymore.`);
    }

    try {
        await git(root, ["worktree", "remove", ...(force ? ["--force"] : []), worktree.path], {
            ...policy,
            readOnly: false,
        });
    } catch (error) {
        const message = describe(error);

        // Git runs in English here (see git.ts), so its words can be matched.
        if (!force && error instanceof GitError && /modified or untracked files/.test(message)) {
            throw new HttpError(409, "The worktree has uncommitted changes.");
        }

        throw new HttpError(500, `The worktree could not be removed: ${message}`);
    }
}

/** Canonical containment is meaningful only on the worktree's own destination. */
export async function inWorktreeAt(
    worktree: Worktree,
    cwd: string,
    backend: WorkspaceBackend,
): Promise<boolean> {
    if (
        (worktree.destination !== undefined && worktree.destination !== backend.id) ||
        (worktree.destination === undefined && backend.remote)
    ) {
        return false;
    }

    try {
        return await backend.contains(worktree.path, cwd);
    } catch (error) {
        if (isMissingWorkspaceFile(error)) {
            return false;
        }

        throw error;
    }
}

function requireWorktreeDestination(worktree: Worktree, backend: WorkspaceBackend): void {
    if (
        (worktree.destination !== undefined && worktree.destination !== backend.id) ||
        (worktree.destination === undefined && backend.remote)
    ) {
        throw new HttpError(
            409,
            "The worktree belongs to another destination; no operation was started.",
        );
    }
}

/** Async source mapping for remote worktrees, including folders absent in the original checkout. */
export async function sourceFolder(
    worktree: Worktree,
    cwd: string,
    policy: WorktreePolicy = {},
): Promise<string> {
    const backend = policy.backend ?? WorkspaceBackend.local(worktree.source);

    requireWorktreeDestination(worktree, backend);
    const root = await repositoryOf(worktree.source, policy);

    if (root === undefined) {
        return worktree.source;
    }

    const base = await backend.canonical(worktree.path);
    const folder = await backend.canonicalWithMissingTail(cwd);
    const tail = backend.paths.relative(base, folder);

    if (
        tail === ".." ||
        tail.startsWith(`..${backend.paths.sep}`) ||
        backend.paths.isAbsolute(tail)
    ) {
        throw new HttpError(409, "The folder is outside this worktree.");
    }

    const mapped = backend.paths.resolve(root, tail);
    const original = await backend.canonical(worktree.source);

    return mapped === original || !(await backend.exists(mapped)) ? worktree.source : mapped;
}

/** Undo a worktree that a session never got: its folder and its branch. */
export async function discardWorktree(
    worktree: Worktree,
    policy: WorktreePolicy = {},
): Promise<void> {
    await removeWorktree(worktree, true, policy);
    const root = await repositoryOf(worktree.source, policy);

    if (root !== undefined) {
        await git(root, ["branch", "-D", worktree.branch], { ...policy, readOnly: false });
    }
}
