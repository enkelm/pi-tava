/** Private owner/token/target passwords, delegated only to a visible explicitly granted project thread. */
import type { Context } from "@earendil-works/chord";
import { BACKGROUND_CONTEXT, withCancel } from "@earendil-works/chord/context";
import type { ConversationId } from "@earendil-works/pi-durable";
import type { PocketApp } from "../app.ts";
import type { User } from "../config.ts";
import { HttpError } from "../errors.ts";
import { SshExecutionEnv, validateSshHost } from "../ssh-env.ts";
import { createSshPassword, SshPasswords, type SshPasswordCredential } from "../ssh-passwords.ts";
import type { SshLifetime } from "./lifetime.ts";

export class SshAuthentication {
    readonly #app: PocketApp;
    readonly #lifetime: SshLifetime;
    readonly #passwords = new SshPasswords();
    readonly #scopes = new Map<string, string>();
    readonly #logins = new Map<string, { ticket: symbol; cancel(): void }>();

    constructor(app: PocketApp, lifetime: SshLifetime) {
        this.#app = app;
        this.#lifetime = lifetime;
    }

    identity(supplied: User): User {
        return {
            ...supplied,
            sessions: supplied.sessions?.slice(),
            projectAccess:
                supplied.projectAccess === undefined
                    ? undefined
                    : {
                          ...supplied.projectAccess,
                          hosts: supplied.projectAccess.hosts?.slice(),
                          projectIds: supplied.projectAccess.projectIds?.slice(),
                      },
        };
    }

    requireIdentity(supplied: User): User {
        this.#lifetime.requireOpen();
        const current = this.#app.config.userById(supplied.id);

        if (
            current === undefined ||
            current.tokenHash !== supplied.tokenHash ||
            current.role !== supplied.role ||
            JSON.stringify(current.sessions) !== JSON.stringify(supplied.sessions) ||
            JSON.stringify(current.projectAccess) !== JSON.stringify(supplied.projectAccess)
        ) {
            throw new HttpError(403, "SSH requester's access changed. Start a fresh request.");
        }

        return current;
    }

    requireOwner(supplied: User): User {
        const current = this.requireIdentity(supplied);

        if (current.role !== "owner") {
            throw new HttpError(403, "Only the signed-in owner may manage SSH login.");
        }

        return current;
    }

    #scope(user: User): string {
        const scope = JSON.stringify([user.id, user.tokenHash]);
        const previous = this.#scopes.get(user.id);

        if (previous !== undefined && previous !== scope) {
            this.#forgetScope(previous);
        }

        this.#scopes.set(user.id, scope);

        return scope;
    }

    #forgetScope(scope: string, host?: string): void {
        if (host === undefined) {
            this.#passwords.forgetUser(scope);
        } else {
            this.#passwords.forget(scope, host);
        }

        for (const [key, login] of this.#logins) {
            const [loginScope, loginHost] = JSON.parse(key);

            if (loginScope === scope && (host === undefined || loginHost === host)) {
                login.cancel();
                this.#logins.delete(key);
            }
        }
    }

    environment(
        user: User,
        host: string,
        cwd: string,
        authorize: () => void,
        thread?: ConversationId,
    ): { env: SshExecutionEnv; checkAccess(): void } {
        const identity = this.identity(user);
        const scope = this.#scope(this.requireIdentity(identity));
        // Delegation is possible only for a real project thread, not a prepared target or a
        // session-only invitation. The transport never receives an owner identity as its actor.
        const projectId =
            thread === undefined
                ? undefined
                : this.#app.sessionMeta(this.#app.rootOf(thread))?.projectId;
        const owner =
            identity.role !== "owner" &&
            identity.projectAccess !== undefined &&
            projectId !== undefined &&
            this.#app.projects.canAccess(identity, projectId)
                ? this.#app.config.users.find((person) => person.role === "owner")
                : undefined;
        const credentialOwner = owner === undefined ? undefined : this.identity(owner);
        let selected = false;
        let credential: SshPasswordCredential | undefined;

        const delegatedCredential = () => {
            if (credentialOwner === undefined) {
                return undefined;
            }

            const current = this.requireIdentity(identity);

            this.requireOwner(credentialOwner);
            this.#app.requireSee(current, thread!);

            if (
                !this.#app.projects.canAccess(current, projectId!) ||
                this.#app.sessionMeta(this.#app.rootOf(thread!))?.projectId !== projectId ||
                this.#app.locationOf(thread!)?.host !== host ||
                this.#app.cwdOf(thread!) !== cwd
            ) {
                throw new HttpError(403, "This project destination is no longer granted.");
            }

            return this.#passwords.get(this.#scope(credentialOwner), host);
        };

        const checkAccess = () => {
            this.requireIdentity(identity);
            authorize();
            const current = delegatedCredential();

            if (selected && current !== credential) {
                throw new HttpError(
                    403,
                    "SSH project login changed. Start a fresh workspace request.",
                );
            }
        };

        const env = new SshExecutionEnv({
            host,
            cwd,
            authorize: checkAccess,
            password: () => {
                checkAccess();

                if (identity.role === "owner") {
                    return this.#passwords.get(scope, host);
                }

                if (!selected) {
                    credential = delegatedCredential();
                    selected = true;
                }

                return credential;
            },
        });

        // Exec/native-reader transports do not have SFTP's final credential check. Their owner
        // and selected login must also remain valid after awaited work, without selecting a
        // replacement password/key or replaying the request. Cleanup is separately unrestricted.
        return { env, checkAccess };
    }

    status(user: User, host: string) {
        this.requireOwner(user);
        validateSshHost(host);

        return this.#passwords.status(this.#scope(user), host);
    }

    forget(user: User, host?: string): void {
        this.requireOwner(user);

        if (host !== undefined) {
            validateSshHost(host);
        }

        this.#forgetScope(this.#scope(user), host);
    }

    revoke(userId: string): void {
        const scope = this.#scopes.get(userId);

        if (scope !== undefined) {
            this.#forgetScope(scope);
            this.#scopes.delete(userId);
        }
    }

    login(
        supplied: User,
        host: string,
        password: string,
        context: Context,
        authorized: () => boolean,
    ) {
        const user = this.identity(supplied);

        this.requireOwner(user);

        if (!authorized()) {
            throw new HttpError(403, "Only the signed-in owner may log in to SSH with a password.");
        }

        validateSshHost(host);
        const key = JSON.stringify([this.#scope(user), host]);

        if (this.#logins.has(key)) {
            throw new HttpError(409, "SSH login is already in progress for this host.");
        }

        if (this.#logins.size >= 8) {
            throw new HttpError(
                429,
                "Too many SSH logins are already in progress. Wait for one to finish.",
            );
        }

        if (!password || Buffer.byteLength(password) > 1024 || /[\r\n\0]/.test(password)) {
            throw new HttpError(
                400,
                "Enter an SSH password without line breaks or NUL characters, at most 1024 UTF-8 bytes.",
            );
        }

        const credential = createSshPassword(password);

        password = "";

        return this.#lifetime.run(context, async (context) => {
            const pending = withCancel(context);
            const attempt = Symbol();
            const env = new SshExecutionEnv({ host, cwd: "~", password: () => credential });
            let saved = false;

            this.#logins.set(key, {
                ticket: attempt,
                cancel: () => {
                    credential.dispose();
                    pending.cancel();
                },
            });

            try {
                const result = await env.canonicalPath("~", pending.context);

                if (!result.ok || !credential.wasPrompted()) {
                    throw new HttpError(
                        409,
                        "SSH password login failed. Check the username and password, and ensure this host's key is already trusted on pi-tava. No new login was saved.",
                    );
                }

                const fresh = this.#app.config.userById(user.id);

                if (
                    fresh?.role !== "owner" ||
                    fresh.tokenHash !== user.tokenHash ||
                    JSON.stringify(fresh.sessions) !== JSON.stringify(user.sessions) ||
                    JSON.stringify(fresh.projectAccess) !== JSON.stringify(user.projectAccess) ||
                    !authorized() ||
                    context.abortSignal?.aborted ||
                    this.#logins.get(key)?.ticket !== attempt
                ) {
                    throw new HttpError(
                        409,
                        "SSH login was cancelled or access changed. No new login was saved.",
                    );
                }

                this.#passwords.set(this.#scope(user), host, credential);
                saved = true;

                return this.status(user, host);
            } finally {
                pending.cancel();

                if (this.#logins.get(key)?.ticket === attempt) {
                    this.#logins.delete(key);
                }

                if (!saved) {
                    credential.dispose();
                }

                await env.cleanup(BACKGROUND_CONTEXT);
            }
        });
    }

    close(): void {
        for (const login of this.#logins.values()) {
            login.cancel();
        }

        this.#passwords.close();
        this.#scopes.clear();
    }
}
