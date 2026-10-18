/** Read-only selection of local Pi instances. Move copies a saved snapshot; it never controls Pi. */
import type { PocketApp } from "../app.ts";
import type { User } from "../config.ts";
import { HttpError } from "../errors.ts";
import type { ImportRequest, PiSessions } from "../pi-sessions.ts";
import { LocalPiSessions } from "./herdr.ts";

export class ActivePiSessions {
    readonly #sessions: PiSessions;
    readonly local = new LocalPiSessions();

    constructor(_app: PocketApp, sessions: PiSessions) {
        this.#sessions = sessions;
    }

    async list(user: User) {
        this.#sessions.requireAccess(user);
        const result = await this.local.list();

        this.#sessions.requireAccess(user);

        return {
            sessions: result.sessions.map((session) => ({
                id: session.id,
                title: session.title,
                cwd: session.cwd,
                location: session.location,
                state: session.state,
                running: ["working", "blocked"].includes(session.state),
                ...(session.reason ? { reason: session.reason } : {}),
            })),
            warnings: result.warnings,
        };
    }

    async resolve(user: User, id: unknown) {
        this.#sessions.requireAccess(user);

        if (typeof id !== "string" || !/^[a-f0-9]{64}$/.test(id)) {
            throw new HttpError(400, "Choose a session from the live Pi list");
        }

        const session = await this.local.find(id);

        this.#sessions.requireAccess(user);

        return session;
    }

    preview(user: User, request: ImportRequest & { id?: unknown }) {
        return this.#sessions.preview(user, { ...request, activeId: request?.id });
    }

    move(user: User, request: ImportRequest & { id?: unknown }) {
        return this.#sessions.create(user, { ...request, activeId: request?.id });
    }
}
