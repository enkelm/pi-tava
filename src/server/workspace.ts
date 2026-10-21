/**
 * A conversation's folder on this machine, as people reach it through the app: which files a person may load or read,
 * the file viewer, the files for `@` mentions, Changes, its git branch, uploads, and new folders from the folder picker. The
 * operations people call directly check who may do them; the path helpers (`conversationPath`, `conversationFile`,
 * `readableFile`, `uploadDirectory`) leave seeing the conversation to their callers.
 */
import { lstatSync, mkdirSync, realpathSync, statSync } from "node:fs";
import localPaths, { isAbsolute, join, posix, resolve, sep } from "node:path";
import { getAgentDir } from "@earendil-works/pi-coding-agent";
import type { ConversationId } from "@earendil-works/pi-durable";
import type { PocketApp } from "./app.ts";
import {
    type Branches,
    branchesIn,
    gitDirOf,
    type Head,
    headOf,
    headIn,
    isRemoteBranch,
    localName,
    switchBranch,
    validBranchName,
} from "./branches.ts";
import { type Changes, changesIn, diffOf, revertFile } from "./changes.ts";
import type { User } from "./config.ts";
import { describe, HttpError } from "./errors.ts";
import {
    decodeText,
    fileEditInput,
    MAX_EDIT_BYTES,
    saveFileEdit,
    textRevision,
} from "./file-edits.ts";
import {
    inspectRemoteFileEdit,
    saveRemoteFileEdit,
    type RemoteEditAuthorization,
} from "./remote-file-edits.ts";
import { FileLists, type FileListing, type FileView, viewFile } from "./files.ts";
import { displayPath, expandHome } from "./paths.ts";
import { requireWorkflowLocalWrite, requireWorkflowRequester } from "./workflow-policy.ts";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import type { Context } from "@earendil-works/chord";
import type { WorkspaceBackend } from "./workspace-backend.ts";
import { userWorkspaceBackend } from "./workspace-backend-factory.ts";
import { SharedWorkspaceReads } from "./workspace-reads.ts";
import {
    remoteError,
    remoteFile,
    remoteFileList,
    remoteImage,
    remoteView,
} from "./remote-workspace.ts";

function inside(paths: typeof posix, root: string, file: string): boolean {
    const relative = paths.relative(root, file);

    return (
        relative === "" ||
        (relative !== ".." && !relative.startsWith(".." + paths.sep) && !paths.isAbsolute(relative))
    );
}

/** One private-root policy for local/remote viewers, scoped reads and edits. Canonicalize at the caller. */
function protectedPath(
    paths: typeof posix,
    file: string,
    data: string,
    agent: string,
    mode: "read" | "edit",
): boolean {
    const exceptions =
        mode === "read" ? ["uploads", "worktrees", "repos"] : ["uploads", "worktrees"];

    return (
        inside(paths, agent, file) ||
        (inside(paths, data, file) &&
            !exceptions.some((part) => inside(paths, paths.join(data, part), file)))
    );
}

export class Workspace {
    readonly #app: PocketApp;

    constructor(app: PocketApp) {
        this.#app = app;
    }

    /** Bind asynchronous filesystem/Git operations to the actual caller's destination and credentials. */
    backend(
        id: ConversationId,
        user?: User,
        context: Context = BACKGROUND_CONTEXT,
    ): WorkspaceBackend {
        return userWorkspaceBackend(this.#app, id, context, user);
    }

    /** Async header observation for SSH; synchronous head never probes a host-local namesake. */
    async destinationHead(
        id: ConversationId,
        user?: User,
        context: Context = BACKGROUND_CONTEXT,
    ): Promise<Head | undefined> {
        return this.#app.sshSessions.withWorkspace(id, user, context, (backend) =>
            headIn(backend.cwd, {
                backend,
                timeoutMs: 5000,
                offline: () => this.#app.workItems.isManaged(id),
            }),
        );
    }

    /** Local-only features must fail before touching a same-named path on the Coop host. */
    #requireLocal(id: ConversationId): void {
        if (this.#app.locationOf(id) !== undefined) {
            throw new HttpError(409, "This operation is not available for SSH workspaces.");
        }
    }

    /** The files in each folder, for `@` mentions. */
    readonly #files = new FileLists();

    /** Brief name-only snapshots, never path authority or a retained authenticated connection. */
    readonly #remoteFiles = new Map<string, { root: string; at: number; listing: FileListing }>();
    readonly #remoteFilesUnderWay = new SharedWorkspaceReads<FileListing>();

    /**
     * The looks at what a conversation's folder changed that are under way, per reach (its folder only, or its
     * repository). Every tab that shows a session asks (the top bar's count), often together as Pi moves on; those that
     * ask while a look is under way share it, as each reads the new history for Pi's edits and runs git. One asked
     * after it ends looks again, so what it says is never older than the question.
     */
    readonly #changesUnderWay = new SharedWorkspaceReads<Changes>();

    /**
     * Where each folder's repository keeps its files, for a minute: views ask on every update. A folder in none is
     * asked about again after a few seconds, so one Pi has just run `git init` in shows its branch soon.
     */
    readonly #gitDirs = new Map<string, { gitDir: string | undefined; at: number }>();

    #gitDir(cwd: string): string | undefined {
        const known = this.#gitDirs.get(cwd);

        if (
            known !== undefined &&
            Date.now() - known.at < (known.gitDir === undefined ? 5000 : 60_000)
        ) {
            return known.gitDir;
        }

        const gitDir = gitDirOf(cwd);

        this.#gitDirs.set(cwd, { gitDir, at: Date.now() });

        return gitDir;
    }

    /** Whether a folder is in a git repository. */
    inRepository(cwd: string): boolean {
        return this.#gitDir(cwd) !== undefined;
    }

    /** What a conversation's folder has checked out, for its view: its repository's HEAD file, read as it is now. */
    head(id: ConversationId): Head | undefined {
        if (this.#app.locationOf(id) !== undefined) {
            return undefined;
        }

        const gitDir = this.#gitDir(this.#app.cwdOf(id));

        return gitDir === undefined ? undefined : headOf(gitDir);
    }

    /** The branches of a session's repository, for the branch sheet: for people who can steer, as Changes is. */
    async branches(id: ConversationId, user: User): Promise<Branches> {
        user = structuredClone(user);
        this.#app.requireSee(user, id);
        this.#app.requireSteer(user);
        const backend = this.backend(id, user);
        const cwd = this.#app.cwdOf(id);

        if (!backend.remote && this.#gitDir(cwd) === undefined) {
            throw new HttpError(404, "This session's folder is not in a git repository.");
        }

        const result = await branchesIn(cwd, {
            backend,
            offline: () => this.#app.workItems.isManaged(id),
        }).catch((error: unknown) => {
            throw new HttpError(409, describe(error));
        });

        requireWorkflowRequester(this.#app, id, user);

        return result;
    }

    /**
     * Switch a session's folder to another branch: one there already, a new one from what is checked out (`create`),
     * or a new one following a remote branch (`track`). It changes the files under Pi, so as with moving the session to
     * another folder it takes the right to drive, someone not invited to one session only, and Pi not working; Pi is
     * told with its next message.
     */
    async switchBranch(
        id: ConversationId,
        user: User,
        request: { name?: unknown; create?: unknown; track?: unknown },
    ): Promise<{ branch: string }> {
        this.#app.requireSee(user, id);
        this.#app.requireSteer(user);

        if (user.role !== "owner") {
            throw new HttpError(
                403,
                "Only the owner may change a thread's branch from this picker.",
            );
        }

        user = structuredClone(user);
        requireWorkflowRequester(this.#app, id, user);
        await this.#app.requireDriver(id, user);
        requireWorkflowLocalWrite(this.#app, id);

        if (this.#app.workItems.isManaged(id)) {
            throw new HttpError(
                409,
                "Switch branches through managed offline bash, so Git child hooks cannot access the network.",
            );
        }

        const track = typeof request.track === "string" ? request.track : undefined;
        const name =
            typeof request.name === "string" ? request.name.trim() : track && localName(track);
        const cwd = this.#app.cwdOf(id);
        const options = { backend: this.backend(id, user) };

        if (track !== undefined && !(await isRemoteBranch(cwd, track, options))) {
            throw new HttpError(400, `${track} is not a remote branch here.`);
        }

        if (!name || !(await validBranchName(cwd, name, options))) {
            throw new HttpError(400, `${name ? `“${name}”` : "That"} cannot be a branch name.`);
        }

        if (this.#app.isBusy(id)) {
            throw new HttpError(
                409,
                "Pi is working here: wait for it, or stop it, before switching branches.",
            );
        }

        const before = await headIn(cwd, options);

        this.#app.requireSee(user, id);
        await this.#app.requireDriver(id, user);
        requireWorkflowLocalWrite(this.#app, id);

        if (this.#app.cwdOf(id) !== cwd || this.#app.isBusy(id)) {
            throw new HttpError(409, "The workspace changed or Pi started working; try again.");
        }

        await switchBranch(
            cwd,
            {
                name,
                create: request.create === true,
                ...(track ? { track } : {}),
            },
            options,
        ).catch((error: unknown) => {
            throw new HttpError(409, describe(error));
        });
        const from = before !== undefined && "branch" in before ? ` from ${before.branch}` : "";
        const what =
            request.create === true || track !== undefined
                ? `made the branch ${name}${track ? `, following ${track},` : ""} and switched to it${from}`
                : `switched the branch${from} to ${name}`;

        await this.#app.commands.note(id, user, what);
        await this.#app.collab.activity(id, user, what);

        return { branch: name };
    }

    /** A folder to work in, as its whole path: a 404 when it is not there, so the folder picker can offer to make it. */
    checkDirectory(path: string): string {
        const absolute = resolve(expandHome(path.trim() === "" ? "~" : path.trim()));
        let found;

        try {
            found = statSync(absolute);
        } catch (error) {
            const code = (error as NodeJS.ErrnoException).code;

            if (code === "ENOTDIR") {
                throw new HttpError(400, `${absolute} is inside a file, not a folder.`);
            }

            if (code === "ELOOP") {
                throw new HttpError(400, `${absolute} is a link to nothing.`);
            }

            if (code !== "ENOENT") {
                throw new HttpError(400, `Could not open ${absolute}: ${describe(error)}`);
            }

            // Not there, unless it is a link to nowhere: that cannot be made a folder either.
            throw lstatSync(absolute, { throwIfNoEntry: false }) === undefined
                ? new HttpError(404, `${absolute} isn't there.`)
                : new HttpError(400, `${absolute} is a link to nothing.`);
        }

        if (!found.isDirectory()) {
            throw new HttpError(400, `${absolute} is a file, not a folder.`);
        }

        return absolute;
    }

    /**
     * Make a folder to start a session in or move one to, with any folders missing above it, for someone who may browse
     * folders (`/api/fs`): who can steer, and was not invited to one session. A folder already there is fine: it is the
     * one asked for. Returns its path.
     */
    makeFolder(user: User, path: string): string {
        this.#app.requireSteer(user);

        const current = this.#app.config.userById(user.id);

        if (
            user.role !== "owner" ||
            current?.role !== "owner" ||
            current.tokenHash !== user.tokenHash
        ) {
            throw new HttpError(403, "Only the owner may create arbitrary working folders.");
        }

        const written = path.trim();

        if (written === "" || written.includes("\0")) {
            throw new HttpError(400, "Name the folder to make.");
        }

        const expanded = expandHome(written);

        if (!isAbsolute(expanded)) {
            throw new HttpError(400, "Give the folder's whole path, from / or ~.");
        }

        const absolute = resolve(expanded);

        try {
            mkdirSync(absolute, { recursive: true });
        } catch (error) {
            const code = (error as NodeJS.ErrnoException).code;

            // A file in the way, or a link that leads nowhere (or in a loop): the path cannot be a folder.
            throw new HttpError(
                409,
                code === "EEXIST" || code === "ENOTDIR"
                    ? `${absolute} is a file, or inside one.`
                    : code === "ENOENT" || code === "ELOOP"
                      ? `${absolute} is a broken link, or inside one.`
                      : `Could not make ${absolute}: ${describe(error)}`,
            );
        }

        // Made, or a folder already: either way it must be a folder now.
        return this.checkDirectory(absolute);
    }

    /** A path as a conversation means it: absolute, `~/…`, or relative to the conversation's working directory. */
    conversationPath(id: ConversationId, path: string): string {
        this.#requireLocal(id);

        return resolve(this.#app.cwdOf(id), expandHome(path.trim()));
    }

    /**
     * A file a person may load through a conversation. People who can steer reach the whole machine through Pi anyway;
     * viewers and people invited to one session get only files under the conversation's folder or its uploads.
     */
    conversationFile(user: User, id: ConversationId, path: string): string {
        const file = this.conversationPath(id, path);

        if (
            user.role !== "viewer" &&
            user.sessions === undefined &&
            user.projectAccess === undefined
        ) {
            return file;
        }

        const real = (target: string) => {
            try {
                return realpathSync(target);
            } catch {
                return undefined;
            }
        };

        const target = real(file);
        const cwd = this.#app.cwdOf(id);
        // A fork shows the messages it inherited, with the files attached to them in the sessions it came from. Their
        // later uploads are in the same folders, but an upload's name has random bits in it and shows only in its
        // message, so nobody who cannot read that message can name the file.
        const uploads = this.#lineage(id).map((each) =>
            join(this.#app.dataDir, "uploads", String(each)),
        );
        const roots = [cwd, ...uploads]
            .map(real)
            .filter((root): root is string => root !== undefined);

        if (
            target === undefined ||
            !roots.some((root) => target === root || target.startsWith(root + sep))
        ) {
            throw new HttpError(404, "Image not found");
        }

        return target;
    }

    /**
     * A file a person may read whole through a session: the viewer, and files sent along with a message. As
     * `conversationFile`, but Pi's own folder (sign-ins, settings) and this app's data (people, tokens, the database)
     * are the owner's alone. Uploads, worktrees, and PiP's clones (`repos/`), which sessions use, are not kept back.
     */
    readableFile(user: User, id: ConversationId, path: string): string {
        const file = this.conversationFile(user, id, path);

        if (user.role === "owner") {
            return file;
        }

        const real = (target: string) => {
            try {
                return realpathSync(target);
            } catch {
                return resolve(target);
            }
        };

        if (
            protectedPath(
                localPaths,
                real(file),
                real(this.#app.dataDir),
                real(getAgentDir()),
                "read",
            )
        ) {
            throw new HttpError(404, "Not found");
        }

        return file;
    }

    /**
     * An existing canonical path eligible for quick edits and language services. As with readableFile, callers
     * check conversation access themselves. Even the owner cannot edit app/Pi configuration through this API.
     */
    editableFile(user: User, id: ConversationId, path: string): string {
        if (typeof path !== "string" || path.trim() === "" || path.includes("\0")) {
            throw new HttpError(400, "Name the file to edit.");
        }

        const file = this.readableFile(user, id, path);
        let canonical: string;

        try {
            canonical = realpathSync(file);
        } catch {
            throw new HttpError(404, "File not found.");
        }

        const real = (root: string) => {
            try {
                return realpathSync(root);
            } catch {
                return resolve(root);
            }
        };

        // Check both spellings: a protected folder's symlink must not grant an edit of its target, nor may an
        // unprotected alias grant an edit of configuration. Exceptions are real subpaths, not symlink targets.
        if (
            protectedPath(
                localPaths,
                canonical,
                real(this.#app.dataDir),
                real(getAgentDir()),
                "edit",
            ) ||
            protectedPath(
                localPaths,
                this.conversationPath(id, path),
                resolve(this.#app.dataDir),
                resolve(getAgentDir()),
                "edit",
            )
        ) {
            throw new HttpError(403, "App data and Pi configuration cannot be edited here.");
        }

        return canonical;
    }

    /** This session and the sessions it was forked from, nearest first. */
    #lineage(id: ConversationId): ConversationId[] {
        const lineage = [id];

        for (
            let meta = this.#app.sessionMeta(id);
            meta?.forkedFrom !== undefined && lineage.length < 64;
        ) {
            const parent = meta.forkedFrom.id as unknown as ConversationId;

            if (lineage.includes(parent)) {
                break;
            }

            lineage.push(parent);
            meta = this.#app.sessionMeta(parent);
        }

        return lineage;
    }

    /**
     * The files in a conversation's folder, for `@` mentions in the message box: for people who can write to Pi. It lists
     * names under the folder only, so someone invited to one session sees no more than `conversationFile` lets them load.
     */
    async fileList(
        id: ConversationId,
        user: User,
        context: Context = BACKGROUND_CONTEXT,
    ): Promise<FileListing> {
        this.#app.requireSee(user, id);
        this.#app.requireSteer(user);
        context.abortSignal?.throwIfAborted();
        const caller = structuredClone(user);
        const identity = JSON.stringify([
            caller.id,
            caller.tokenHash,
            caller.role,
            caller.sessions,
            caller.projectAccess,
        ]);
        const cwd = this.#app.cwdOf(id);
        const location = JSON.stringify(this.#app.locationOf(id));

        await this.#app.conversation(id);
        context.abortSignal?.throwIfAborted();

        if (location !== undefined) {
            const authorize = () => {
                const live = this.#app.config.userById(caller.id);

                if (
                    live === undefined ||
                    JSON.stringify([
                        live.id,
                        live.tokenHash,
                        live.role,
                        live.sessions,
                        live.projectAccess,
                    ]) !== identity
                ) {
                    throw new HttpError(
                        403,
                        "Your authority changed. Start a fresh file-list request.",
                    );
                }

                this.#app.requireSee(live, id);
                this.#app.requireSteer(live);

                if (
                    this.#app.cwdOf(id) !== cwd ||
                    JSON.stringify(this.#app.locationOf(id)) !== location
                ) {
                    throw new HttpError(
                        409,
                        "The workspace destination changed. Reload its files.",
                    );
                }
            };

            try {
                authorize();
                const key = JSON.stringify([id, identity, location, cwd]);
                const result = await this.#remoteFilesUnderWay.run(key, context, (shared) =>
                    this.#app.sshSessions.withWorkspace(id, caller, shared, async (backend) => {
                        const root = await backend.canonical(cwd);

                        if ((await backend.lstat(root)).kind !== "directory") {
                            throw new HttpError(
                                409,
                                "The workspace root is no longer a directory.",
                            );
                        }

                        const cached = this.#remoteFiles.get(key);
                        let listing: FileListing;

                        // Every operation verifies the current canonical root, even a fresh cache hit.
                        if (
                            cached !== undefined &&
                            cached.root === root &&
                            Date.now() - cached.at < 5000
                        ) {
                            listing = cached.listing;
                        } else {
                            listing = await remoteFileList(backend.env, backend.context);

                            if ((await backend.canonical(cwd)) !== root) {
                                throw new HttpError(
                                    409,
                                    "The workspace root changed while listing files.",
                                );
                            }
                        }

                        authorize();
                        backend.context.abortSignal?.throwIfAborted();

                        if (listing !== cached?.listing) {
                            this.#remoteFiles.delete(key);
                            this.#remoteFiles.set(key, { root, at: Date.now(), listing });

                            for (const oldest of this.#remoteFiles.keys()) {
                                if (this.#remoteFiles.size <= 16) {
                                    break;
                                }

                                this.#remoteFiles.delete(oldest);
                            }
                        }

                        return listing;
                    }),
                );

                context.abortSignal?.throwIfAborted();
                authorize();

                return result;
            } catch (error) {
                throw remoteError(error);
            }
        }

        requireWorkflowRequester(this.#app, id, caller, true);

        if (this.#app.cwdOf(id) !== cwd || JSON.stringify(this.#app.locationOf(id)) !== location) {
            throw new HttpError(409, "The workspace destination changed. Reload its files.");
        }

        const result = await this.#files.get(cwd);

        context.abortSignal?.throwIfAborted();
        requireWorkflowRequester(this.#app, id, caller, true);

        if (this.#app.cwdOf(id) !== cwd || JSON.stringify(this.#app.locationOf(id)) !== location) {
            throw new HttpError(409, "The workspace destination changed. Reload its files.");
        }

        return result;
    }

    /** A source name, not path authority: shared reads never accept credentials or traversal. */
    sourcePath(path?: string): string {
        if (
            !path ||
            path.includes("\0") ||
            path.includes("\\") ||
            path.startsWith("/") ||
            path.startsWith("~") ||
            /^[a-z]:/i.test(path) ||
            path.split("/").some((part) => ["..", ".git", ".ssh", ".aws", ".gnupg"].includes(part))
        ) {
            throw new HttpError(400, "Use a source path relative to the shared folder");
        }

        return path;
    }

    /** Shared source discovery uses the same local Git/remote dispatcher as human file mentions. */
    async sourceFiles(
        id: ConversationId,
        user: User,
        context: Context = BACKGROUND_CONTEXT,
    ): Promise<{ files: string[]; truncated: boolean }> {
        user = structuredClone(user);

        return this.#sourceRead(id, user, context, async (backend, root, permitted) => {
            const listing = await this.fileList(id, user, context);
            const files = listing.files.filter((path) => {
                try {
                    this.sourcePath(path);
                } catch {
                    return false;
                }

                return permitted(backend.paths.resolve(root, path));
            });

            return { files, truncated: listing.truncated };
        });
    }

    /** Complete bounded UTF-8 source, confined even for owners; never the broad human file viewer. */
    async sourceFile(
        id: ConversationId,
        user: User,
        path: string,
        context: Context = BACKGROUND_CONTEXT,
    ): Promise<{ text: string; revision: string }> {
        path = this.sourcePath(path);

        return this.#sourceRead(id, user, context, async (backend, root, permitted) => {
            const file = await backend.canonical(path);

            if (!permitted(file)) {
                throw new HttpError(404, "That file is outside the shared folder");
            }

            // Aliases must not bypass protected relative directories such as .ssh or .git.
            this.sourcePath(backend.paths.relative(root, file));
            const snapshot = backend.remote
                ? await inspectRemoteFileEdit({
                      backend,
                      root,
                      file,
                      offline: this.#app.workItems.isManaged(id),
                  })
                : { bytes: await backend.readBytes(file, MAX_EDIT_BYTES), revision: undefined };

            if ((await backend.canonical(path)) !== file) {
                throw new HttpError(409, "The file's location changed during the read");
            }

            const text = decodeText(snapshot.bytes);

            if (text === undefined) {
                throw new HttpError(415, "Only UTF-8 source text can be read");
            }

            return { text, revision: snapshot.revision ?? textRevision(snapshot.bytes) };
        });
    }

    /** Keep destination, live requester, private-root exclusions and canonical rechecks in one owner. */
    async #sourceRead<T>(
        id: ConversationId,
        user: User,
        context: Context,
        read: (
            backend: WorkspaceBackend,
            root: string,
            permitted: (path: string) => boolean,
        ) => Promise<T>,
    ): Promise<T> {
        user = structuredClone(user);
        requireWorkflowRequester(this.#app, id, user);
        context.abortSignal?.throwIfAborted();

        return this.#app.sshSessions.withWorkspace(id, user, context, async (backend) => {
            const root = await backend.canonical(backend.cwd);
            const agent = await backend.canonicalWithMissingTail(
                backend.remote ? "~/.pi/agent" : getAgentDir(),
            );
            const data = await backend.canonicalWithMissingTail(
                backend.remote ? "~/.pi-durable-app" : this.#app.dataDir,
            );

            const permitted = (path: string) =>
                inside(backend.paths, root, path) &&
                !protectedPath(backend.paths, path, data, agent, "read");

            if (!permitted(root)) {
                throw new HttpError(404, "Private application context is not shared code");
            }

            const result = await read(backend, root, permitted);

            if ((await backend.canonical(backend.cwd)) !== root) {
                throw new HttpError(409, "The folder's location changed during the read");
            }

            context.abortSignal?.throwIfAborted();
            requireWorkflowRequester(this.#app, id, user);

            return result;
        });
    }

    /**
     * A file or folder for the viewer, as a person who can steer may load it through the session (`conversationFile`):
     * its text, or that it is an image, a folder's entries, or binary.
     */
    async viewFile(
        id: ConversationId,
        user: User,
        path: string,
        context: Context = BACKGROUND_CONTEXT,
    ): Promise<
        { path: string; display: string; editable?: boolean; editUnavailable?: string } & FileView
    > {
        this.#app.requireSee(user, id);
        this.#app.requireSteer(user);
        user = structuredClone(user);
        requireWorkflowRequester(this.#app, id, user, true);
        const cwd = this.#app.cwdOf(id);
        const location = JSON.stringify(this.#app.locationOf(id));

        await this.#app.conversation(id);
        requireWorkflowRequester(this.#app, id, user, true);

        if (cwd !== this.#app.cwdOf(id) || location !== JSON.stringify(this.#app.locationOf(id))) {
            throw new HttpError(409, "The workspace changed while opening the file.");
        }

        if (location !== undefined) {
            try {
                return await this.#app.sshSessions.withWorkspace(
                    id,
                    user,
                    context,
                    async (backend) => {
                        const env = backend.env;
                        const file = await remoteFile(
                            env,
                            path,
                            user.role === "viewer" ||
                                user.sessions !== undefined ||
                                user.projectAccess !== undefined,
                            context,
                        );
                        let editable = false;
                        let editUnavailable: string | undefined;
                        const view = await remoteView(env, file, context, async () => {
                            if (this.#app.workItems.executionBlocked(id)) {
                                editUnavailable = "This workflow is read-only.";

                                return undefined;
                            }

                            try {
                                const root =
                                    user.sessions !== undefined || user.projectAccess !== undefined
                                        ? await backend.canonical(backend.cwd)
                                        : "/";
                                const snapshot = await inspectRemoteFileEdit({
                                    backend,
                                    root,
                                    file,
                                    offline: this.#app.workItems.isManaged(id),
                                });

                                await this.#remoteEditProtection(backend, snapshot.path, path);
                                editable = !this.#app.workItems.executionBlocked(id);
                                editUnavailable = editable
                                    ? undefined
                                    : "This workflow is read-only.";

                                // Displayed bytes and revision are the same opened snapshot, without an SFTP download first.
                                return {
                                    kind: "text",
                                    text: decodeText(snapshot.bytes)!,
                                    size: snapshot.bytes.length,
                                    truncated: false,
                                    revision: snapshot.revision,
                                };
                            } catch (error) {
                                context.abortSignal?.throwIfAborted();
                                editUnavailable = describe(error);

                                return undefined;
                            }
                        });

                        if (view.kind === "text" && view.truncated) {
                            editUnavailable =
                                "Quick save requires complete UTF-8 text of at most 512 KiB.";
                        }

                        return {
                            path: file,
                            display: posix.relative(env.cwd, file) || ".",
                            ...view,
                            ...(view.kind === "text"
                                ? {
                                      editable,
                                      ...(editUnavailable === undefined ? {} : { editUnavailable }),
                                  }
                                : {}),
                        };
                    },
                );
            } catch (error) {
                throw remoteError(error);
            }
        }

        let file: string;

        try {
            file = this.readableFile(user, id, path);
            const cwd = this.#app.cwdOf(id);
            const view = await viewFile(file);

            requireWorkflowRequester(this.#app, id, user, true);

            if (cwd !== this.#app.cwdOf(id) || this.#app.locationOf(id) !== undefined) {
                throw new HttpError(409, "The workspace changed while reading the file.");
            }

            let editable = false;

            if (view.kind === "text" && view.revision !== undefined) {
                try {
                    const canonical = this.editableFile(user, id, path);
                    const info = lstatSync(canonical);

                    editable =
                        info.isFile() &&
                        info.nlink === 1 &&
                        !this.#app.workItems.executionBlocked(id);
                } catch {
                    // Read access does not grant quick-edit access, including for the owner.
                }
            }

            return {
                path: file,
                display: displayPath(file, this.#app.cwdOf(id)),
                ...view,
                ...(view.kind === "text" ? { editable } : {}),
            };
        } catch (error) {
            if (error instanceof HttpError || (error as NodeJS.ErrnoException).code === "ENOENT") {
                throw new HttpError(404, `${path} is not there.`);
            }

            throw new HttpError(409, describe(error));
        }
    }

    /** Remote defaults are resolved on the target, never against host-local namesakes. */
    async #remoteEditProtection(
        backend: WorkspaceBackend,
        file: string,
        requested = file,
    ): Promise<void> {
        const targets = [file, await backend.absolute(requested)];
        const agent = [
            await backend.absolute("~/.pi/agent"),
            await backend.canonicalWithMissingTail("~/.pi/agent"),
        ];
        const data = [
            await backend.absolute("~/.pi-durable-app"),
            await backend.canonicalWithMissingTail("~/.pi-durable-app"),
        ];

        if (
            targets.some((target) =>
                data.some((root, index) =>
                    protectedPath(backend.paths, target, root, agent[index]!, "edit"),
                ),
            )
        ) {
            throw new HttpError(403, "App data and Pi configuration cannot be edited here.");
        }

        backend.checkAccess();
    }

    /** Save existing complete text without overwriting an intervening edit, then tell Pi and collaborators. */
    async saveFile(
        id: ConversationId,
        user: User,
        path: unknown,
        text: unknown,
        revision: unknown,
        /** A source-bound action can additionally pin its earlier read through every save authorization. */
        guard?: () => Promise<void>,
    ): Promise<{ revision: string; warning?: string }> {
        user = structuredClone(user);
        this.#app.requireSee(user, id);
        const input = fileEditInput(path, text, revision);
        const location = this.#app.locationOf(id);
        const originalCwd = this.#app.cwdOf(id);
        const projectId = this.#app.sessionMeta(this.#app.rootOf(id))?.projectId;
        let remoteSavedFile: string | undefined;

        const assertLive = () => {
            requireWorkflowRequester(this.#app, id, user);

            if (
                JSON.stringify(this.#app.locationOf(id)) !== JSON.stringify(location) ||
                this.#app.cwdOf(id) !== originalCwd ||
                this.#app.sessionMeta(this.#app.rootOf(id))?.projectId !== projectId
            ) {
                throw new HttpError(
                    409,
                    "The workspace destination changed. Reload before saving.",
                );
            }

            return this.#app.config.userById(user.id)!;
        };

        const remoteAuthorize = async (): Promise<RemoteEditAuthorization> => {
            let current = assertLive();

            await this.#app.conversation(id);
            await this.#app.requireDriver(id, current);
            current = assertLive();
            requireWorkflowLocalWrite(this.#app, id);

            if (this.#app.isBusy(id)) {
                throw new HttpError(
                    409,
                    "Pi is working here: wait for it, or stop it, before saving a file.",
                );
            }

            const backend = this.backend(id, current);
            const onlyHere = current.sessions !== undefined || current.projectAccess !== undefined;
            const file = await remoteFile(backend.env, input.path, onlyHere);
            const root = onlyHere ? await backend.canonical(backend.cwd) : "/";

            await this.#remoteEditProtection(backend, file, input.path);
            await guard?.();
            await this.#app.requireDriver(id, assertLive());
            assertLive();
            requireWorkflowLocalWrite(this.#app, id);

            if (this.#app.isBusy(id)) {
                throw new HttpError(
                    409,
                    "Pi started working here. Stop it before saving this file.",
                );
            }

            remoteSavedFile = file;

            return { backend, root, file, offline: this.#app.workItems.isManaged(id) };
        };

        const authorize = async () => {
            assertLive();
            await this.#app.conversation(id);
            await this.#app.requireDriver(id, assertLive());

            if (guard !== undefined) {
                await guard();
                await this.#app.requireDriver(id, assertLive());
            }

            // A queued save may have waited behind another conversation's save of this same path.
            assertLive();
            requireWorkflowLocalWrite(this.#app, id);

            if (this.#app.isBusy(id)) {
                throw new HttpError(
                    409,
                    "Pi is working here: wait for it, or stop it, before saving a file.",
                );
            }

            return this.editableFile(user, id, input.path);
        };

        const result =
            location === undefined
                ? await saveFileEdit(input, authorize)
                : await saveRemoteFileEdit(input, remoteAuthorize);
        const shown =
            location === undefined
                ? displayPath(this.conversationPath(id, input.path), this.#app.cwdOf(id))
                : posix.relative(originalCwd, remoteSavedFile!) || ".";
        const what = `edited ${shown}`;
        const recorded = await Promise.allSettled([
            this.#app.commands.note(id, user, what),
            this.#app.collab.activity(id, user, what),
        ]);
        const failed = recorded.filter((record) => record.status === "rejected");

        if (failed.length > 0) {
            for (const record of failed) {
                this.#app.log(`file saved but edit recording failed: ${describe(record.reason)}`);
            }

            return { ...result, warning: "File saved, but the edit could not be fully recorded." };
        }

        return result;
    }

    /**
     * Undo the uncommitted changes to one file of a session's repository. It changes files under Pi, so it takes the
     * right to drive and waits until Pi is not working; Pi is told, with its next message.
     */
    async revertChange(id: ConversationId, user: User, path: string): Promise<void> {
        user = structuredClone(user);
        this.#app.requireSee(user, id);
        await this.#app.requireDriver(id, user);
        requireWorkflowLocalWrite(this.#app, id);

        if (this.#app.workItems.isManaged(id)) {
            throw new HttpError(
                409,
                "Undo changes through managed offline bash, so Git child hooks cannot access the network.",
            );
        }

        if (this.#app.isBusy(id)) {
            throw new HttpError(
                409,
                "Pi is working here: wait for it, or stop it, before undoing a file.",
            );
        }

        const kind = await revertFile(
            this.#app.cwdOf(id),
            path,
            user.sessions !== undefined || user.projectAccess !== undefined,
            {
                backend: this.backend(id, user),
            },
        ).catch((error: unknown) => {
            throw new HttpError(409, describe(error));
        });
        const what =
            kind === "new" || kind === "added"
                ? `deleted ${path}, which was new since the last commit`
                : `undid the uncommitted changes to ${path}`;

        this.#forgetChanges(id);
        await this.#app.commands.note(id, user, what);
        await this.#app.collab.activity(id, user, what);
    }

    /** What changed in a session's folder: Pi's edits, and the uncommitted changes of its git repository. */
    async changes(
        id: ConversationId,
        user: User,
        context: Context = BACKGROUND_CONTEXT,
    ): Promise<Changes> {
        user = structuredClone(user);
        this.#app.requireSee(user, id);
        this.#app.requireSteer(user);
        requireWorkflowRequester(this.#app, id, user, true);
        const cwd = this.#app.cwdOf(id);
        const location = JSON.stringify(this.#app.locationOf(id));
        const onlyHere = user.sessions !== undefined || user.projectAccess !== undefined;
        const key = `${id}:${JSON.stringify([user.id, user.tokenHash, user.role, user.sessions, user.projectAccess, location, cwd])}`;
        const result = await this.#changesUnderWay.run(key, context, (shared) =>
            this.#app.sshSessions.withWorkspace(id, user, shared, async (backend) =>
                changesIn(
                    backend.cwd,
                    await this.#app.transcripts.editEntries(id, backend.context),
                    onlyHere,
                    { backend, offline: () => this.#app.workItems.isManaged(id) },
                ),
            ),
        );

        // Every consumer retains its own cancellation and final authority, even when it shared the read.
        context.abortSignal?.throwIfAborted();
        requireWorkflowRequester(this.#app, id, user, true);

        if (cwd !== this.#app.cwdOf(id) || location !== JSON.stringify(this.#app.locationOf(id))) {
            throw new HttpError(409, "The workspace changed while reading Changes.");
        }

        return result;
    }

    /** Looks under way began before a file was undone: one asked from now on looks again. */
    #forgetChanges(id: ConversationId): void {
        this.#changesUnderWay.forget(`${id}:`);
    }

    /** The diff of one changed file in a session's repository. */
    async changeDiff(
        id: ConversationId,
        user: User,
        path: string,
        context: Context = BACKGROUND_CONTEXT,
    ): Promise<string> {
        user = structuredClone(user);
        this.#app.requireSee(user, id);
        this.#app.requireSteer(user);

        try {
            return await this.#app.sshSessions.withWorkspace(id, user, context, (backend) =>
                diffOf(
                    backend.cwd,
                    path,
                    user.sessions !== undefined || user.projectAccess !== undefined,
                    {
                        backend,
                        offline: () => this.#app.workItems.isManaged(id),
                    },
                ),
            );
        } catch (error) {
            throw new HttpError(404, describe(error));
        }
    }

    /** Remote image reads keep authorization and file namespace together across asynchronous transport. */
    async imageBytes(
        id: ConversationId,
        user: User,
        path: string,
        context: Context = BACKGROUND_CONTEXT,
    ): Promise<Buffer> {
        user = structuredClone(user);
        this.#app.requireSee(user, id);

        if (this.#app.locationOf(id) === undefined) {
            throw new HttpError(409, "Use the local image route for local files.");
        }

        try {
            return await this.#app.sshSessions.withWorkspace(id, user, context, async (backend) => {
                const file = await remoteFile(
                    backend.env,
                    path,
                    user.role === "viewer" ||
                        user.sessions !== undefined ||
                        user.projectAccess !== undefined,
                    backend.context,
                );

                return remoteImage(backend.env, file, backend.context);
            });
        } catch (error) {
            throw remoteError(error);
        }
    }

    /** Explicit host-upload namespace, even in SSH threads. Never probes a local project namesake. */
    hostUploadFile(id: ConversationId, path: string): string | undefined {
        for (const each of new Set([id, ...this.#lineage(this.#app.rootOf(id))])) {
            const directory = join(this.#app.dataDir, "uploads", String(each));

            if (!path.startsWith(directory + sep)) {
                continue;
            }

            try {
                const root = realpathSync(directory);
                const file = realpathSync(path);

                if (file.startsWith(root + sep) && statSync(file).isFile()) {
                    return file;
                }
            } catch {
                // Missing or escaping uploads do not acquire host filesystem access.
            }

            throw new HttpError(404, "Upload not found");
        }

        return undefined;
    }

    uploadDirectory(id: ConversationId): string {
        // Attachments stay on the Coop host; stage_upload explicitly copies only one file to SSH.
        requireWorkflowLocalWrite(this.#app, id);
        const directory = join(this.#app.dataDir, "uploads", String(id));

        mkdirSync(directory, { recursive: true });

        return directory;
    }
}
