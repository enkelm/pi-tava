/** Actual-caller SSH HEAD observations for synchronous room/session projections. */
import type { ConversationId } from "@earendil-works/pi-durable";
import { BACKGROUND_CONTEXT, withCancel } from "@earendil-works/chord/context";
import type { PocketApp } from "./app.ts";
import type { Head } from "./branches.ts";
import type { User } from "./config.ts";

export const DESTINATION_HEAD_MS = 3000;
const MAX_HEADS = 256;

type Observation = {
    head: Head | undefined;
    at: number;
    pending: boolean;
};

export class DestinationHeads {
    readonly #app: PocketApp;
    readonly #heads = new Map<string, Observation>();
    readonly #reads = new Set<{
        id: ConversationId;
        userId: string;
        key: string;
        cancel: () => void;
        done: Promise<void>;
    }>();
    #closed = false;

    constructor(app: PocketApp) {
        this.#app = app;
    }

    /** Remote reads are never attributed to an owner or the last agent when a caller is absent. */
    get(id: ConversationId, supplied?: User): Head | undefined {
        if (this.#closed) {
            return undefined;
        }

        const location = this.#app.locationOf(id);

        if (location === undefined) {
            return this.#app.workspace.head(id);
        }

        const selection = this.#selection(id, supplied);

        if (selection === undefined) {
            return undefined;
        }

        const { user, identity, projectId, locationKey, cwd, key } = selection;
        let observation = this.#heads.get(key);

        if (observation !== undefined) {
            // LRU keeps frequently displayed destinations while never evicting in-flight lookups.
            this.#heads.delete(key);
            this.#heads.set(key, observation);

            if (observation.pending || Date.now() - observation.at < DESTINATION_HEAD_MS) {
                return observation.head;
            }
        } else {
            if (this.#heads.size >= MAX_HEADS) {
                const evict = [...this.#heads].find(([, item]) => !item.pending)?.[0];

                if (evict === undefined) {
                    return undefined;
                }

                this.#heads.delete(evict);
            }

            observation = { head: undefined, at: 0, pending: false };
            this.#heads.set(key, observation);
        }

        const entry = observation;

        const identityValid = () => {
            const current = this.#app.config.userById(user.id);

            return (
                !this.#closed &&
                current !== undefined &&
                JSON.stringify([
                    current.id,
                    current.tokenHash,
                    current.role,
                    current.sessions,
                    current.projectAccess,
                ]) === identity &&
                this.#app.canSee(current, id) &&
                this.#app.sessionMeta(this.#app.rootOf(id))?.projectId === projectId &&
                this.#app.cwdOf(id) === cwd &&
                JSON.stringify(this.#app.locationOf(id)) === locationKey
            );
        };

        const valid = () => identityValid() && this.#heads.get(key) === entry;

        const notify = () => {
            if (!valid()) {
                return;
            }

            this.#app.scheduleSessions();
            void this.#app.openRoom(id)?.then(
                (room) => {
                    if (identityValid()) {
                        room.schedule();
                    }
                },
                () => {},
            );
        };

        entry.pending = true;
        // Snapshot the actual identity: configuration updates can mutate a User object in place.
        const requester = structuredClone(user);

        const pending = withCancel(BACKGROUND_CONTEXT);
        const read = {
            id,
            userId: user.id,
            key,
            cancel: () => pending.cancel(),
            done: Promise.resolve(),
        };

        this.#reads.add(read);
        read.done = Promise.resolve()
            .then(() => {
                if (!valid()) {
                    throw new Error("HEAD observation invalidated before starting");
                }

                return this.#app.workspace.destinationHead(id, requester, pending.context);
            })
            .then(
                (head) => {
                    if (!valid()) {
                        if (this.#heads.get(key) === entry) {
                            this.#heads.delete(key);
                        }

                        return;
                    }

                    const changed = JSON.stringify(entry.head) !== JSON.stringify(head);

                    entry.head = head;
                    entry.at = Date.now();
                    entry.pending = false;

                    if (changed) {
                        notify();
                    }
                },
                () => {
                    if (this.#heads.get(key) !== entry) {
                        return;
                    }

                    const visible = entry.head !== undefined;

                    // Drop a previous successful value on refresh failure; neither failure nor stale HEAD sticks.
                    if (visible && valid()) {
                        entry.head = undefined;
                        notify();
                    }

                    this.#heads.delete(key);
                },
            )
            .finally(() => {
                pending.cancel();
                this.#reads.delete(read);
            });

        return entry.head;
    }

    /** HEAD belongs to visible room readers, not a disconnected/hidden tab or a passive catalogue. */
    releaseUnwatched(): void {
        for (const read of this.#reads) {
            if (!this.#app.watching(read.userId, read.id)) {
                this.#heads.delete(read.key);
                read.cancel();
            }
        }
    }

    /** Passive SSH sidebar projection: no lookup, refresh, connection or local filesystem I/O. */
    peek(id: ConversationId, supplied?: User): Head | undefined {
        const selection = this.#selection(id, supplied);

        return selection === undefined ? undefined : this.#heads.get(selection.key)?.head;
    }

    #selection(id: ConversationId, supplied?: User) {
        if (this.#closed) {
            return undefined;
        }

        const location = this.#app.locationOf(id);
        const user = supplied === undefined ? undefined : this.#app.config.userById(supplied.id);

        if (
            location === undefined ||
            user === undefined ||
            user.tokenHash !== supplied?.tokenHash ||
            user.role !== supplied.role ||
            JSON.stringify(user.sessions) !== JSON.stringify(supplied.sessions) ||
            JSON.stringify(user.projectAccess) !== JSON.stringify(supplied.projectAccess) ||
            !this.#app.canSee(user, id)
        ) {
            return undefined;
        }

        const identity = JSON.stringify([
            user.id,
            user.tokenHash,
            user.role,
            user.sessions,
            user.projectAccess,
        ]);
        const cwd = this.#app.cwdOf(id);
        const projectId = this.#app.sessionMeta(this.#app.rootOf(id))?.projectId;

        return {
            user: structuredClone(user),
            identity,
            projectId,
            cwd,
            locationKey: JSON.stringify(location),
            key: JSON.stringify([id, identity, projectId, location, cwd]),
        };
    }

    /** Cancel target reads, suppress their projections, and join their full transport lifetimes. */
    async close(): Promise<void> {
        this.#closed = true;
        this.#heads.clear();

        for (const read of this.#reads) {
            read.cancel();
        }

        await Promise.allSettled([...this.#reads].map((read) => read.done));
    }
}
