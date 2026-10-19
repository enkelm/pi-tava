/** SSH destinations: exact callers, credentials, guarded workspace lifetimes, trust and joined shutdown. */
import type { Context } from "@earendil-works/chord";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import type { ConversationId } from "@earendil-works/pi-durable";
import {
    err,
    ExecutionError,
    FileError,
    getOrThrow,
    type ExecutionEnv,
    type ShellExecOptions,
} from "@earendil-works/pi-durable/env";
import type { PocketApp } from "./app.ts";
import type { User } from "./config.ts";
import { HttpError } from "./errors.ts";
import { remoteDirectory, remoteError, remoteFolders } from "./remote-workspace.ts";
import { SshExecutionEnv, withSshFileSystem } from "./ssh-env.ts";
import { discoverSshHosts } from "./ssh-hosts.ts";
import { protectSshEnv } from "./ssh-policy.ts";
import { SshAuthentication } from "./ssh-sessions/authentication.ts";
import {
    guardedBackend,
    workspaceAuthorization,
    writerReservation,
} from "./ssh-sessions/backend.ts";
import { SshLifetime } from "./ssh-sessions/lifetime.ts";
import { SshResources } from "./ssh-sessions/resources.ts";
import type { TrustChoice } from "./skills.ts";
import { requireWorkflowRequester } from "./workflow-policy.ts";
import type { WorkspaceBackend } from "./workspace-backend.ts";
import { userWorkspaceBackend } from "./workspace-backend-factory.ts";
import type { WorkspaceLocation } from "./workspace-location.ts";

type Destination = { location: WorkspaceLocation; cwd: string };

export class SshSessions {
    readonly #app: PocketApp;
    readonly #home: string;
    readonly #lifetime = new SshLifetime();
    readonly #authentication: SshAuthentication;
    readonly #resources: SshResources;
    readonly #environments = new Set<WeakRef<SshExecutionEnv>>();
    // A discarded metadata-only backend need not stay alive. An environment which owns a
    // temporary remote resource must stay alive until explicit cleanup or shutdown.
    readonly #resourceOwners = new Set<SshExecutionEnv>();
    readonly #collected = new FinalizationRegistry<WeakRef<SshExecutionEnv>>((reference) => {
        this.#environments.delete(reference);
    });
    readonly #legacy = new Map<string, { env: ExecutionEnv; checkAccess(): void }>();
    #closing?: Promise<void>;

    constructor(app: PocketApp, home: string) {
        this.#app = app;
        this.#home = home;
        this.#authentication = new SshAuthentication(app, this.#lifetime);
        this.#resources = new SshResources(app, this);
    }

    hosts(supplied: User) {
        const user = this.#authentication.identity(supplied);

        return this.#lifetime.run(BACKGROUND_CONTEXT, async () => {
            this.#authentication.requireOwner(user);
            const hosts = await discoverSshHosts({ home: this.#home });

            this.#authentication.requireOwner(user);

            return hosts;
        });
    }

    status(user: User, host: string) {
        return this.#authentication.status(user, host);
    }

    login(user: User, host: string, password: string, context: Context, authorized: () => boolean) {
        return this.#authentication
            .login(user, host, password, context, authorized)
            .then((status) => {
                this.#legacy.clear();

                return status;
            });
    }

    forget(user: User, host?: string): void {
        this.#authentication.forget(user, host);
        this.#legacy.clear();
    }

    /** Revocation also works after the old token/person is no longer current. */
    revoke(userId: string): void {
        this.#authentication.revoke(userId);
        this.#legacy.clear();
    }

    #actor(id: ConversationId, supplied?: User): User {
        // No session creator or previous-turn fallback. Agent attribution is checked again after every await.
        const actor =
            supplied ?? this.#app.config.userById(requireWorkflowRequester(this.#app, id))!;

        return this.#authentication.identity(actor);
    }

    #environment(
        user: User,
        host: string,
        cwd: string,
        authorize: () => void,
        thread?: ConversationId,
    ) {
        const { env: raw, checkAccess } = this.#authentication.environment(
            user,
            host,
            cwd,
            authorize,
            thread,
        );

        const reference = new WeakRef(raw);

        this.#environments.add(reference);
        this.#collected.register(raw, reference, raw);
        const tracked = new Proxy(raw, {
            get: (target, property) => {
                const value = Reflect.get(target, property, target);

                if (typeof value !== "function") {
                    return value;
                }

                if (property === "cleanup") {
                    return async () => {
                        try {
                            await target.cleanup(BACKGROUND_CONTEXT);
                        } finally {
                            this.#environments.delete(reference);
                            this.#resourceOwners.delete(target);
                            this.#collected.unregister(target);
                        }
                    };
                }

                return (...args: unknown[]) => {
                    const context = args.at(-1) as Context;

                    return this.#lifetime.run(context, async (context) => {
                        checkAccess();
                        args[args.length - 1] = context;

                        if (property === "exec" || property === "execConfined") {
                            const index = property === "exec" ? 1 : 2;
                            const options = args[index] as ShellExecOptions | undefined;

                            if (options?.onOutput !== undefined) {
                                args[index] = {
                                    ...options,
                                    onOutput: (text, ctx, info) => {
                                        checkAccess();
                                        options.onOutput!(text, ctx, info);
                                    },
                                } satisfies ShellExecOptions;
                            }
                        }

                        const result = await Reflect.apply(value, target, args);

                        if (
                            typeof result === "object" &&
                            result !== null &&
                            "ok" in result &&
                            result.ok === true &&
                            (property === "createTempDir" ||
                                property === "createTempFile" ||
                                ("value" in result &&
                                    typeof result.value === "object" &&
                                    result.value !== null &&
                                    "spillPath" in result.value))
                        ) {
                            this.#resourceOwners.add(target);
                        }

                        checkAccess();

                        return result;
                    });
                };
            },
        });

        return { raw, tracked, checkAccess };
    }

    #workspace(
        id: ConversationId,
        supplied: User | undefined,
        context: Context,
        exclusive = false,
    ) {
        const user = this.#actor(id, supplied);
        const location = this.#app.locationOf(id);

        if (location === undefined) {
            throw new Error("The conversation has no SSH destination.");
        }

        const policy = workspaceAuthorization(this.#app, id, user, supplied === undefined);
        let active = true;

        const authorize = (write: boolean) => {
            if (!active) {
                throw new HttpError(
                    409,
                    "The workspace operation has finished. Start a fresh request.",
                );
            }

            policy(write);
        };

        authorize(false);
        const { raw, tracked, checkAccess } = this.#environment(
            user,
            location.host,
            this.#app.cwdOf(id),
            () => authorize(false),
            id,
        );
        const backend = guardedBackend({
            raw: tracked,
            remote: true,
            context,
            authorize: (write) => {
                authorize(write);
                checkAccess();
            },
            confinedExec: (command, options, ctx, readOnly) =>
                tracked.execConfined(readOnly, command, options, ctx),
            managed: () => this.#app.workItems.isManaged(id),
            ...(exclusive ? {} : { reserveWrite: writerReservation(this.#app, id) }),
        });

        return {
            raw,
            backend,
            release: () => {
                active = false;
            },
        };
    }

    /** Compatibility for exclusive core operations. Returns guarded capabilities, never the SSH transport. */
    backend(
        id: ConversationId,
        actor: User | undefined,
        context: Context,
        exclusive = false,
    ): WorkspaceBackend {
        return this.#workspace(id, actor, context, exclusive).backend;
    }

    /** One pinned compound operation: independent caller, cancellation, final authorization and joined cleanup. */
    withWorkspace<T>(
        id: ConversationId,
        actor: User | undefined,
        context: Context,
        operation: (backend: WorkspaceBackend) => Promise<T>,
    ): Promise<T> {
        return this.#lifetime.run(context, async (context) => {
            if (this.#app.locationOf(id) === undefined) {
                const backend = userWorkspaceBackend(this.#app, id, context, actor);

                try {
                    const result = await operation(backend);

                    this.#finish(backend, context);

                    return result;
                } finally {
                    await backend.env.cleanup(BACKGROUND_CONTEXT);
                }
            }

            const { raw, backend, release } = this.#workspace(id, actor, context);

            try {
                return await withSshFileSystem(
                    raw,
                    async () => {
                        const result = await operation(backend);

                        this.#finish(backend, context);

                        return result;
                    },
                    context,
                );
            } finally {
                try {
                    await backend.env.cleanup(BACKGROUND_CONTEXT);
                } finally {
                    release();
                }
            }
        });
    }

    #finish(backend: WorkspaceBackend, context: Context): void {
        backend.checkAccess();

        if (context.abortSignal?.aborted) {
            throw new HttpError(
                409,
                "The workspace request was cancelled. No automatic retry was attempted.",
            );
        }
    }

    #arbitrary(supplied: User): User {
        return this.#authentication.requireOwner(supplied);
    }

    /** Only the owner may prepare arbitrary destinations; project guests use their pinned thread. */
    prepare(user: User, destination: Destination, context: Context): Promise<string>;
    prepare<T>(
        user: User,
        destination: Destination,
        context: Context,
        operation: (backend: WorkspaceBackend) => Promise<T>,
    ): Promise<T>;
    prepare<T>(
        supplied: User,
        destination: Destination,
        context: Context,
        operation?: (backend: WorkspaceBackend) => Promise<T>,
    ): Promise<string | T> {
        const user = this.#authentication.identity(supplied);

        this.#arbitrary(user);

        return this.#destination(user, destination, context, async (backend) => {
            const cwd = await remoteDirectory(backend.env, destination.cwd || "~", backend.context);

            return operation === undefined ? cwd : operation(backend.at(cwd));
        });
    }

    #destination<T>(
        user: User,
        destination: Destination,
        context: Context,
        operation: (backend: WorkspaceBackend) => Promise<T>,
    ): Promise<T> {
        return this.#lifetime.run(context, async (context) => {
            let active = true;

            const authorize = () => {
                if (!active) {
                    throw new HttpError(
                        409,
                        "The destination operation has finished. Start a fresh request.",
                    );
                }

                this.#arbitrary(user);
            };

            const { raw, tracked, checkAccess } = this.#environment(
                user,
                destination.location.host,
                destination.cwd,
                authorize,
            );
            const backend = guardedBackend({
                raw: tracked,
                context,
                remote: true,
                authorize: () => checkAccess(),
                managed: () => false,
                confinedExec: (command, options, ctx, readOnly) =>
                    tracked.execConfined(readOnly, command, options, ctx),
            });

            try {
                return await withSshFileSystem(
                    raw,
                    async () => {
                        const result = await operation(backend);

                        this.#finish(backend, context);

                        return result;
                    },
                    context,
                );
            } catch (error) {
                throw remoteError(error);
            } finally {
                try {
                    await backend.env.cleanup(BACKGROUND_CONTEXT);
                } finally {
                    active = false;
                }
            }
        });
    }

    browse(supplied: User, host: string, requested: string, hidden: boolean, context: Context) {
        const user = this.#authentication.identity(supplied);

        this.#arbitrary(user);

        return this.#destination(
            user,
            { location: { kind: "ssh", host }, cwd: "~" },
            context,
            async (backend) => {
                const listing = await remoteFolders(
                    backend.env,
                    requested,
                    hidden,
                    backend.context,
                );

                listing.recent = [
                    ...new Set(
                        this.#app
                            .sessions(user)
                            .filter(
                                (session) =>
                                    this.#app.locationOf(session.id as ConversationId)?.host ===
                                    host,
                            )
                            .map((session) => session.cwd),
                    ),
                ].slice(0, 8);

                return listing;
            },
        );
    }

    createDirectory(supplied: User, host: string, path: string, context: Context) {
        const user = this.#authentication.identity(supplied);
        const written = path.trim();

        this.#arbitrary(user);

        if (
            !written ||
            written.includes("\0") ||
            (!written.startsWith("/") && written !== "~" && !written.startsWith("~/"))
        ) {
            throw new HttpError(400, "Give the folder's whole path, from / or ~.");
        }

        return this.#destination(
            user,
            { location: { kind: "ssh", host }, cwd: "~" },
            context,
            async (backend) => {
                getOrThrow(
                    await backend.env.createDir(written, { recursive: true }, backend.context),
                );

                return { path: await remoteDirectory(backend.env, written, backend.context) };
            },
        );
    }

    /** Legacy agents receive only guarded ExecutionEnv methods. Each call selects its current attributed person. */
    envFor(id: ConversationId, cwd: string, supplied?: User): ExecutionEnv {
        supplied = supplied === undefined ? undefined : this.#authentication.identity(supplied);
        const location = this.#app.locationOf(id);

        if (location === undefined) {
            throw new Error("The conversation has no SSH destination.");
        }

        const locationKey = JSON.stringify(location);
        const used = new Set<ExecutionEnv>();

        const environment = () => {
            if (
                JSON.stringify(this.#app.locationOf(id)) !== locationKey ||
                this.#app.cwdOf(id) !== cwd
            ) {
                throw new HttpError(
                    409,
                    "The workspace destination changed. Start a fresh request.",
                );
            }

            const user = this.#actor(id, supplied);
            const projectId = this.#app.sessionMeta(this.#app.rootOf(id))?.projectId;
            const delegated =
                user.role !== "owner" &&
                user.projectAccess !== undefined &&
                projectId !== undefined &&
                this.#app.projects.canAccess(user, projectId);
            const key = JSON.stringify([
                id,
                location,
                cwd,
                user.id,
                user.tokenHash,
                user.role,
                user.sessions,
                user.projectAccess,
                projectId,
                delegated
                    ? this.#app.config.users.find((person) => person.role === "owner")?.tokenHash
                    : undefined,
                supplied === undefined,
            ]);
            let cached = this.#legacy.get(key);

            if (cached === undefined) {
                const authorize = workspaceAuthorization(
                    this.#app,
                    id,
                    user,
                    supplied === undefined,
                );
                const { tracked, checkAccess } = this.#environment(
                    user,
                    location.host,
                    cwd,
                    () => authorize(false),
                    id,
                );

                cached = { env: protectSshEnv(this.#app, id, tracked, user), checkAccess };
                this.#legacy.set(key, cached);
            }

            used.add(cached.env);

            return cached;
        };

        return new Proxy({ id: `ssh:${location.host}`, cwd } as ExecutionEnv, {
            get: (target, property) => {
                if (property === "id" || property === "cwd") {
                    return target[property];
                }

                if (property === "execConfined" || property === "then") {
                    return undefined;
                }

                if (property === "cleanup") {
                    return async () => {
                        await Promise.allSettled(
                            [...used].map((env) => env.cleanup(BACKGROUND_CONTEXT)),
                        );

                        for (const [key, cached] of this.#legacy) {
                            if (used.has(cached.env)) {
                                this.#legacy.delete(key);
                            }
                        }

                        used.clear();
                    };
                }

                return async (...args: unknown[]) => {
                    let cached: ReturnType<typeof environment> | undefined;

                    try {
                        cached = environment();
                        cached.checkAccess();
                        const value = Reflect.get(cached.env, property, cached.env);
                        const result = await Reflect.apply(value, cached.env, args);

                        cached.checkAccess();

                        return result;
                    } catch (error) {
                        if (cached !== undefined) {
                            for (const [key, entry] of this.#legacy) {
                                if (entry === cached) {
                                    this.#legacy.delete(key);
                                }
                            }
                        }

                        const message = error instanceof Error ? error.message : String(error);

                        return err(
                            property === "exec"
                                ? new ExecutionError("shell_unavailable", message)
                                : new FileError("permission_denied", message),
                        );
                    }
                };
            },
        });
    }

    projectTrust(id: ConversationId, user: User) {
        return this.#resources.trust(id, user);
    }

    setProjectTrust(id: ConversationId, user: User, choice: TrustChoice) {
        return this.#resources.setTrust(id, user, choice);
    }

    projectResources(id: ConversationId, actor: User | undefined, context: Context) {
        return this.#resources.load(id, actor, context);
    }

    modelDefault(user: User, host: string, cwd: string, context?: Context) {
        return this.#resources.modelDefault(user, host, cwd, context);
    }

    close(): Promise<void> {
        this.#closing ??= (async () => {
            this.#authentication.close();
            await this.#lifetime.close();
            await Promise.allSettled(
                [...this.#environments].map((reference) =>
                    reference.deref()?.cleanup(BACKGROUND_CONTEXT),
                ),
            );
            this.#environments.clear();
            this.#resourceOwners.clear();
            this.#legacy.clear();
        })();

        return this.#closing;
    }
}
