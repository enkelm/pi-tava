/** Host-owned remote trust choices and bounded target resources, coordinated with SSH request lifetimes. */
import { posix } from "node:path";
import type { Context } from "@earendil-works/chord";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import type { ConversationId } from "@earendil-works/pi-durable";
import type { PocketApp } from "../app.ts";
import type { User } from "../config.ts";
import { HttpError } from "../errors.ts";
import { inspectRemoteFileEdit } from "../remote-file-edits.ts";
import type { WorkspaceBackend } from "../workspace-backend.ts";
import {
    RemoteProjectResources,
    type RemoteProjectFileReader,
    type RemoteProjectTrustDecision,
} from "../remote-project-resources.ts";
import type { SshSessions } from "../ssh-sessions.ts";
import type { TrustChoice } from "../skills.ts";

export class SshResources {
    readonly #app: PocketApp;
    readonly #sessions: SshSessions;
    readonly #resources = new RemoteProjectResources();

    constructor(app: PocketApp, sessions: SshSessions) {
        this.#app = app;
        this.#sessions = sessions;
    }

    #owner(id: ConversationId | undefined, supplied: User): User {
        const current = this.#app.config.userById(supplied.id);

        if (
            current === undefined ||
            current.tokenHash !== supplied.tokenHash ||
            current.role !== supplied.role ||
            current.role !== "owner" ||
            JSON.stringify(current.sessions) !== JSON.stringify(supplied.sessions) ||
            JSON.stringify(current.projectAccess) !== JSON.stringify(supplied.projectAccess)
        ) {
            throw new HttpError(403, "Only the signed-in owner decides project trust.");
        }

        if (id !== undefined) {
            this.#app.requireSee(current, id);
        }

        return current;
    }

    #unchanged(decisions: readonly RemoteProjectTrustDecision[]): void {
        if (JSON.stringify(decisions) !== JSON.stringify(this.#app.config.remoteProjectTrust)) {
            throw new HttpError(
                409,
                "Project trust changed while loading resources. Retry the request.",
            );
        }
    }

    #openedRead(backend: WorkspaceBackend, id?: ConversationId): RemoteProjectFileReader {
        return async (file, root) => {
            const snapshot = await inspectRemoteFileEdit({
                backend,
                root,
                file,
                offline: id !== undefined && this.#app.handoffs.isManaged(id),
            });

            return snapshot.bytes;
        };
    }

    async load(id: ConversationId, actor: User | undefined, context: Context) {
        const decisions = this.#app.config.remoteProjectTrust;

        return this.#sessions.withWorkspace(id, actor, context, async (backend) => {
            const loaded = await this.#resources.load(
                backend.env,
                backend.cwd,
                decisions,
                backend.context,
                this.#openedRead(backend, id),
            );

            this.#unchanged(decisions);

            return loaded;
        });
    }

    async trust(id: ConversationId, supplied: User) {
        const user = structuredClone(supplied);

        this.#owner(id, user);

        try {
            return (await this.load(id, user, BACKGROUND_CONTEXT)).trust;
        } finally {
            this.#owner(id, user);
        }
    }

    async setTrust(id: ConversationId, supplied: User, choice: TrustChoice) {
        const user = structuredClone(supplied);

        this.#owner(id, user);

        try {
            await this.#sessions.withWorkspace(id, user, BACKGROUND_CONTEXT, async (backend) => {
                const decisions = this.#app.config.remoteProjectTrust;
                const now = await this.#resources.load(
                    backend.env,
                    backend.cwd,
                    decisions,
                    backend.context,
                    this.#openedRead(backend, id),
                );

                this.#unchanged(decisions);
                const replacement = await this.#resources.saveTrust(
                    backend.env,
                    backend.cwd,
                    decisions,
                    choice,
                    backend.context,
                );

                // Keep the public 403 even if the transport notices revocation before the trust module does.
                this.#owner(id, user);
                backend.checkAccess();
                const decision = replacement.at(-1)!;
                const expected =
                    choice === "trust-parent" ? posix.dirname(now.trust.folder) : now.trust.folder;

                if (decision.filesystem !== backend.id || decision.path !== expected) {
                    throw new HttpError(
                        409,
                        "The workspace changed. Reload project trust before choosing.",
                    );
                }

                this.#app.config.remoteProjectTrust = [
                    ...this.#app.config.remoteProjectTrust.filter(
                        (entry) =>
                            entry.filesystem !== backend.id ||
                            (entry.path !== expected && entry.path !== now.trust.folder),
                    ),
                    decision,
                ];
            });
        } finally {
            this.#owner(id, user);
        }

        return this.trust(id, user);
    }

    modelDefault(supplied: User, host: string, cwd: string, context: Context = BACKGROUND_CONTEXT) {
        const user = structuredClone(supplied);

        // No thread is pinned yet. A missing trust decision must not turn this arbitrary
        // destination API into a guest-accessible probe or an authentication bypass.
        this.#owner(undefined, user);
        const decisions = this.#app.config.remoteProjectTrust;

        if (!decisions.some((entry) => entry.filesystem === `ssh:${host}`)) {
            return Promise.resolve(undefined);
        }

        return this.#sessions.prepare(
            user,
            { location: { kind: "ssh", host }, cwd },
            context,
            async (backend) => {
                const selected = await this.#resources.modelDefault(
                    backend.env,
                    backend.cwd,
                    decisions,
                    this.#app.models,
                    backend.context,
                    this.#openedRead(backend),
                );

                this.#unchanged(decisions);

                return selected === undefined
                    ? undefined
                    : {
                          model: { provider: selected.model.provider, modelId: selected.model.id },
                          thinkingLevel: selected.thinkingLevel,
                      };
            },
        );
    }
}
