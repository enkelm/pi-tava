import { mkdir, readFile, writeFile, rename, rm } from "node:fs/promises";
import { dirname } from "node:path";
import { randomUUID } from "node:crypto";
import type {
    ModelsStore,
    ModelsStoreEntry,
    ModelsStoreOperationOptions,
} from "@earendil-works/pi-ai";

export type CatalogSnapshot = {
    fingerprint: string;
    entries: Record<string, ModelsStoreEntry>;
};

/** Public ModelsStore implementation. Only the parent publishes accepted configuration snapshots. */
export class CatalogModelsStore implements ModelsStore {
    private path: string;
    private state: CatalogSnapshot;
    private queue = Promise.resolve();

    constructor(path: string, state: CatalogSnapshot) {
        this.path = path;
        this.state = structuredClone(state);
    }

    static async open(path: string, fingerprint: string): Promise<CatalogModelsStore> {
        let state: CatalogSnapshot = { fingerprint, entries: {} };

        try {
            const stored = JSON.parse(await readFile(path, "utf8"));

            if (
                stored.fingerprint === fingerprint &&
                stored.entries &&
                typeof stored.entries === "object" &&
                !Array.isArray(stored.entries)
            ) {
                state = stored;
            }
        } catch (error) {
            if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
                throw new Error("Provider catalog cache could not be read");
            }
        }

        return new CatalogModelsStore(path, state);
    }

    async snapshot(): Promise<CatalogSnapshot> {
        await this.queue;

        return structuredClone(this.state);
    }

    async read(
        providerId: string,
        options?: ModelsStoreOperationOptions,
    ): Promise<ModelsStoreEntry | undefined> {
        options?.signal?.throwIfAborted();
        const state = await this.snapshot();

        options?.signal?.throwIfAborted();

        return state.entries[providerId];
    }

    write(
        providerId: string,
        entry: ModelsStoreEntry,
        options?: ModelsStoreOperationOptions,
    ): Promise<void> {
        return this.mutate((state) => {
            state.entries[providerId] = structuredClone(entry);
        }, options);
    }

    delete(providerId: string, options?: ModelsStoreOperationOptions): Promise<void> {
        return this.mutate((state) => {
            delete state.entries[providerId];
        }, options);
    }

    replace(snapshot: CatalogSnapshot): Promise<void> {
        return this.mutate((state) => {
            state.fingerprint = snapshot.fingerprint;
            state.entries = structuredClone(snapshot.entries);
        });
    }

    private mutate(
        update: (state: CatalogSnapshot) => void,
        options?: ModelsStoreOperationOptions,
    ): Promise<void> {
        const mutation = this.queue.then(async () => {
            options?.signal?.throwIfAborted();
            const state = structuredClone(this.state);

            update(state);
            await mkdir(dirname(this.path), { recursive: true, mode: 0o700 });
            const temporary = `${this.path}.${randomUUID()}.tmp`;

            try {
                await writeFile(temporary, JSON.stringify(state), { mode: 0o600 });
                options?.signal?.throwIfAborted();
                await rename(temporary, this.path);
                this.state = state;
            } finally {
                await rm(temporary, { force: true });
            }
        });

        this.queue = mutation.catch(() => undefined);

        return mutation;
    }
}
