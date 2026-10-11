import { mkdtemp, mkdir, lstat, readlink, symlink, rm, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { resolve, join } from "node:path";
import { randomUUID, createHash } from "node:crypto";
import {
    createAssistantMessageEventStream,
    defaultProviderAuthContext,
    type Provider,
    type Api,
    type Model,
    type TranscriptContext,
    type StreamOptions,
    type AuthContext,
} from "@earendil-works/pi-ai";
import { Connection } from "./pi-provider-host/connection.ts";
import { CatalogModelsStore } from "./pi-provider-host/models-store.ts";
import {
    assertSerializable,
    failureMessage,
    REQUEST_TIMEOUT_MS,
    STARTUP_TIMEOUT_MS,
    SERIALIZATION_ERROR,
    type HostConfiguration,
    type ProviderDescription,
} from "./pi-provider-host/protocol.ts";

export type PiProviderHostOptions = {
    /** Already installed, approved immutable package. This host never installs dependencies. */
    packageRoot: string;
    /** Dedicated directory, with provider settings.json prewritten by its owner. */
    agentDir: string;
    /** External credential store, linked rather than copied into agentDir. */
    authPath: string;
    profile?: "litellm" | "native";
    providerIds?: string[];
    log?: (message: string) => void;
    /** Maximum request workers, excluding the single catalog worker. Default 4; range 1–16. */
    maxLanes?: number;
    /** Idle retention in milliseconds. Default 30s; 0 means per-request disposal; at most 5m. */
    idleTimeoutMs?: number;
    /** Durable configuration-scoped cache, outside disposable agent settings dirs. */
    modelsStorePath?: string;
    /** Native auth context; only LiteLLM API key and root are forwarded into the child env. */
    authContext?: AuthContext;
};

type Lane = {
    connection: Connection;
    root: string;
    tail: Promise<void>;
};

type LaneSlot = {
    opening: Promise<Lane>;
    lane?: Lane;
    requests: number;
    lastUsed: number;
    idleTimer?: NodeJS.Timeout;
    retirement?: Promise<void>;
};

const CAPACITY_ERROR = "Provider host request capacity reached; no idle lane is available";

async function acquire(lane: Lane, signal?: AbortSignal): Promise<() => void> {
    const previous = lane.tail;
    let release!: () => void;
    const held = new Promise<void>((resolve) => {
        release = resolve;
    });

    lane.tail = previous.then(() => held);

    try {
        await new Promise<void>((resolve, reject) => {
            const abort = () => reject(new Error("Queued provider request aborted"));

            if (signal?.aborted) {
                abort();

                return;
            }

            signal?.addEventListener("abort", abort, { once: true });
            void previous.then(() => {
                signal?.removeEventListener("abort", abort);
                resolve();
            });
        });

        return release;
    } catch (error) {
        release();

        throw error;
    }
}

/**
 * Headless public-SDK extension host. Defaults to four request workers plus one catalog worker,
 * with 30-second idle expiry and immediate idle LRU eviction when another session needs capacity.
 * Opening and retiring workers count against capacity; all-busy admission fails without spawning.
 * Transactional refresh permits one bounded standby catalog until replacement is accepted.
 * API-key chat providers only; not an OS sandbox. Pi's loader currently supports root SDK
 * aliases but not every SDK subpath import. LiteLLM's disabled optional-feature profile is 4.2.0.
 */
export class PiProviderHost {
    private options: PiProviderHostOptions;
    private catalog?: Lane;
    private catalogOpening?: Promise<Lane>;
    private lanes = new Map<string, LaneSlot>();
    private retiring = new Set<Promise<void>>();
    private children = new Set<Lane>();
    private descriptions: ProviderDescription[] = [];
    private providers: Provider[] = [];
    private fingerprint?: string;
    private cache!: CatalogModelsStore;
    private closed = false;
    private refreshing = false;
    private active = 0;
    private opening = new Set<Promise<Lane>>();

    private constructor(options: PiProviderHostOptions) {
        const maxLanes = options.maxLanes ?? 4;
        const idleTimeoutMs = options.idleTimeoutMs ?? 30_000;

        if (
            !Number.isInteger(maxLanes) ||
            maxLanes < 1 ||
            maxLanes > 16 ||
            !Number.isInteger(idleTimeoutMs) ||
            idleTimeoutMs < 0 ||
            idleTimeoutMs > 300_000
        ) {
            throw new Error("Invalid provider host worker capacity or idle timeout");
        }

        this.options = {
            ...options,
            maxLanes,
            idleTimeoutMs,
            packageRoot: resolve(options.packageRoot),
            agentDir: resolve(options.agentDir),
            authPath: resolve(options.authPath),
            modelsStorePath: resolve(
                options.modelsStorePath ?? join(options.agentDir, "host-models.json"),
            ),
        };
    }

    static async open(options: PiProviderHostOptions): Promise<PiProviderHost> {
        const host = new PiProviderHost(options);

        try {
            await host.prepare();
            host.catalog = await host.spawn("catalog");
            const result = await host.catalog.connection.call("catalog");

            await host.cache.replace(result.snapshot);
            host.fingerprint = result.fingerprint;
            host.descriptions = result.providers;
            host.providers = host.descriptions.map((description) => host.proxy(description));

            return host;
        } catch (error) {
            await host.close();

            throw error;
        }
    }

    private async prepare(): Promise<void> {
        await mkdir(this.options.agentDir, { recursive: true, mode: 0o700 });
        const settings = await readFile(join(this.options.agentDir, "settings.json"), "utf8");
        const manifest = await readFile(join(this.options.packageRoot, "package.json"), "utf8");
        const fingerprint = createHash("sha256").update(settings).update(manifest).digest("hex");

        this.cache = await CatalogModelsStore.open(this.options.modelsStorePath!, fingerprint);
        const path = join(this.options.agentDir, "auth.json");

        if (path === this.options.authPath) {
            return;
        }

        try {
            const stat = await lstat(path);

            if (
                !stat.isSymbolicLink() ||
                resolve(this.options.agentDir, await readlink(path)) !== this.options.authPath
            ) {
                throw new Error(
                    "Provider host agentDir/auth.json must link to the supplied authPath",
                );
            }
        } catch (error) {
            if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
                throw error;
            }

            await symlink(this.options.authPath, path);
        }
    }

    private spawn(sessionId: string, candidate = false): Promise<Lane> {
        const opening = this.start(sessionId, candidate);

        this.opening.add(opening);
        void opening.finally(() => this.opening.delete(opening)).catch(() => undefined);

        return opening;
    }

    private async start(sessionId: string, candidate: boolean): Promise<Lane> {
        this.assertOpen();
        const snapshot = await this.cache.snapshot();
        const bootstrapEnv: Partial<Record<"LITELLM_API_KEY" | "LITELLM_BASE_URL", string>> = {};

        if (this.options.profile === "litellm") {
            const context = this.options.authContext ?? defaultProviderAuthContext();

            for (const name of ["LITELLM_API_KEY", "LITELLM_BASE_URL"] as const) {
                const value = await context.env(name);

                if (value !== undefined) {
                    bootstrapEnv[name] = value;
                }
            }
        }

        const root = await mkdtemp(join(tmpdir(), "pi-provider-host-"));

        if (this.closed) {
            await rm(root, { recursive: true, force: true });
            this.assertOpen();
        }

        const configuration: HostConfiguration = {
            packageRoot: this.options.packageRoot,
            agentDir: this.options.agentDir,
            authPath: this.options.authPath,
            profile: this.options.profile ?? "native",
            providerIds: this.options.providerIds,
            cwd: root,
            sessionId,
            restoreOnly: Object.values(snapshot.entries).some((entry) => entry.models.length > 0),
        };
        const lane: Lane = {
            connection: new Connection(configuration, bootstrapEnv),
            root,
            tail: Promise.resolve(),
        };

        this.children.add(lane);

        try {
            const result = await lane.connection.call(
                "initialize",
                { snapshot },
                {},
                undefined,
                STARTUP_TIMEOUT_MS,
            );

            this.assertOpen();

            if (!candidate && this.fingerprint && result.fingerprint !== this.fingerprint) {
                throw new Error("Provider host configuration changed; explicit refresh required");
            }

            return lane;
        } catch (error) {
            await this.dispose(lane);

            throw error;
        }
    }

    private assertOpen(): void {
        if (this.closed) {
            throw new Error("Provider host closed");
        }
    }

    getProviders(): readonly Provider[] {
        return this.providers;
    }

    private async catalogLane(): Promise<Lane> {
        this.assertOpen();

        if (this.refreshing) {
            throw new Error("Provider host catalog is refreshing");
        }

        if (this.catalog && !this.catalog.connection.dead) {
            return this.catalog;
        }

        if (!this.catalogOpening) {
            const previous = this.catalog;

            this.catalogOpening = (async () => {
                if (previous) {
                    await this.dispose(previous);
                }

                const lane = await this.spawn("catalog");

                this.catalog = lane;

                return lane;
            })();
        }

        const opening = this.catalogOpening;

        try {
            const lane = await opening;

            if (this.refreshing) {
                throw new Error("Provider host catalog is refreshing");
            }

            return lane;
        } finally {
            if (this.catalogOpening === opening) {
                this.catalogOpening = undefined;
            }
        }
    }

    /** Synchronous admission reserves capacity before the first async initialization step. */
    private requestLane(sessionId: string): LaneSlot {
        const existing = this.lanes.get(sessionId);

        if (existing) {
            existing.requests++;
            clearTimeout(existing.idleTimer);

            return existing;
        }

        let predecessor: Promise<void> | undefined;

        if (this.lanes.size + this.retiring.size >= this.options.maxLanes!) {
            const idle = [...this.lanes]
                .filter(([, slot]) => !slot.requests && slot.lane)
                .sort((a, b) => a[1].lastUsed - b[1].lastUsed)[0];

            if (idle) {
                predecessor = this.retire(idle[0], idle[1]);
            } else {
                predecessor = this.retiring.values().next().value;
            }

            if (!predecessor) {
                throw new Error(CAPACITY_ERROR);
            }

            // Transfer the retiring worker's capacity reservation to its replacement. Spawn
            // only after exit is joined, so rapid expiry/replacement cannot oversubscribe RAM.
            this.retiring.delete(predecessor);
        }

        let slot!: LaneSlot;
        const opening = (async () => {
            await predecessor;
            const lane = await this.spawn(sessionId);

            slot.lane = lane;

            return lane;
        })();

        slot = { opening, requests: 1, lastUsed: performance.now() };
        this.lanes.set(sessionId, slot);

        return slot;
    }

    private retire(sessionId: string, slot: LaneSlot): Promise<void> {
        if (slot.retirement) {
            return slot.retirement;
        }

        clearTimeout(slot.idleTimer);

        if (this.lanes.get(sessionId) === slot) {
            this.lanes.delete(sessionId);
        }

        const retirement = slot.opening
            .catch(() => undefined)
            .then(async (lane) => {
                if (lane) {
                    await this.dispose(lane);
                }
            });

        slot.retirement = retirement;
        this.retiring.add(retirement);
        void retirement.finally(() => this.retiring.delete(retirement)).catch(() => undefined);

        return retirement;
    }

    private proxy(description: ProviderDescription): Provider {
        const filtered = new WeakMap<object, readonly Model<Api>[]>();
        let ambientFiltered: readonly Model<Api>[] | undefined;

        const authCall = async (
            op: string,
            input: { ctx: AuthContext; credential?: unknown; signal: AbortSignal },
        ) => {
            const lane = await this.catalogLane();

            const result = await lane.connection.call(
                op,
                { providerId: description.id, credential: input.credential },
                {
                    callback: (name, data) => {
                        if (name === "env") {
                            if (this.options.authContext) {
                                return this.options.authContext.env(data);
                            }

                            return input.ctx.env(data);
                        }

                        if (name === "fileExists") {
                            return (this.options.authContext ?? input.ctx).fileExists(data);
                        }

                        throw new Error("Unsupported auth callback");
                    },
                },
                input.signal,
            );

            if (description.filter) {
                if (input.credential && typeof input.credential === "object") {
                    filtered.set(input.credential, result.filtered);
                } else {
                    ambientFiltered = result.filtered;
                }
            }

            return result.result;
        };

        const provider: Provider = {
            id: description.id,
            get name() {
                return description.name;
            },
            get baseUrl() {
                return description.baseUrl;
            },
            get headers() {
                return description.headers;
            },
            auth: {
                apiKey: {
                    name: description.apiKeyName,
                    resolve: (input) => authCall("resolve", input),
                    ...(description.check
                        ? {
                              check: (
                                  input: Parameters<
                                      NonNullable<NonNullable<Provider["auth"]["apiKey"]>["check"]>
                                  >[0],
                              ) => authCall("check", input),
                          }
                        : {}),
                    ...(description.login
                        ? {
                              login: async (
                                  interaction: Parameters<
                                      NonNullable<NonNullable<Provider["auth"]["apiKey"]>["login"]>
                                  >[0],
                              ) => {
                                  const lane = await this.catalogLane();

                                  return lane.connection.call(
                                      "login",
                                      { providerId: description.id },
                                      {
                                          callback: (name, data, callbackSignal) => {
                                              if (name === "prompt") {
                                                  return interaction.prompt({
                                                      ...data,
                                                      signal: AbortSignal.any([
                                                          interaction.signal,
                                                          callbackSignal,
                                                      ]),
                                                  });
                                              }

                                              if (name === "notify") {
                                                  interaction.notify(data);

                                                  return;
                                              }

                                              throw new Error("Unsupported login callback");
                                          },
                                      },
                                      interaction.signal,
                                  );
                              },
                          }
                        : {}),
                },
            },
            getModels: () => description.models,
            stream: (model, context, options) =>
                this.stream(description.id, "stream", model, context, options),
            streamSimple: (model, context, options) =>
                this.stream(description.id, "streamSimple", model, context, options),
        };

        if (description.filter) {
            provider.filterModels = (models, credential) => {
                const available = credential ? filtered.get(credential) : ambientFiltered;

                if (!available) {
                    throw new Error("Provider availability requires an awaited native auth check");
                }

                return available.filter((entry) =>
                    models.some((candidate) => candidate.id === entry.id),
                );
            };
        }

        if (description.refresh) {
            provider.refreshModels = async (context) => {
                context.signal.throwIfAborted();

                if (context.allowNetwork) {
                    await this.refresh();
                }

                context.signal.throwIfAborted();
                const snapshot = await this.cache.snapshot();

                // The config-scoped accepted catalog is authoritative. Outer SDK caches may
                // not overwrite it with models from a different package/configuration.
                await context.publish({
                    persist: { ...snapshot.entries[description.id], models: description.models },
                });
            };
        }

        return provider;
    }

    private stream(
        providerId: string,
        method: string,
        model: Model<Api>,
        context: TranscriptContext,
        options: StreamOptions = {},
    ) {
        const stream = createAssistantMessageEventStream();

        void this.runStream(providerId, method, model, context, options, (event) =>
            stream.push(event),
        )
            .then((terminal) => {
                stream.push(terminal);
                stream.end();
            })
            .catch((error: unknown) => {
                const message = failureMessage(
                    model,
                    !!options.signal?.aborted || this.closed,
                    error instanceof Error &&
                        [SERIALIZATION_ERROR, CAPACITY_ERROR].includes(error.message)
                        ? error.message
                        : "Provider host request failed; remote outcome may be unknown",
                );

                stream.push({
                    type: "error",
                    reason: message.stopReason === "aborted" ? "aborted" : "error",
                    error: message,
                });
                stream.end();
            });

        return stream;
    }

    private async runStream(
        providerId: string,
        method: string,
        model: Model<Api>,
        context: TranscriptContext,
        options: StreamOptions,
        emit: (event: any) => void,
    ): Promise<any> {
        this.assertOpen();

        if (this.refreshing || options.signal?.aborted) {
            throw new Error("Provider host unavailable or request aborted");
        }

        const { signal, onPayload, onResponse, onProviderStreamEvent, ...wireOptions } = options;

        assertSerializable({ model, context, options: wireOptions });
        const sessionId = options.sessionId ?? `auxiliary:${randomUUID()}`;
        const auxiliary = !options.sessionId;
        const slot = this.requestLane(sessionId);

        this.active++;
        let lane: Lane | undefined;
        let terminal: any;
        let release: (() => void) | undefined;

        try {
            lane = await slot.opening;
            release = await acquire(lane, signal);
            await lane.connection.call(
                "stream",
                {
                    providerId,
                    method,
                    model,
                    context,
                    options: wireOptions,
                    callbacks: {
                        onPayload: !!onPayload,
                        onResponse: !!onResponse,
                        onProviderStreamEvent: !!onProviderStreamEvent,
                    },
                },
                {
                    event: (event) => {
                        if (!this.closed && !signal?.aborted) {
                            if (event.type === "done" || event.type === "error") {
                                terminal = event;
                            } else {
                                emit(event);
                            }
                        }
                    },
                    callback: (name, data) => {
                        if (name === "onPayload") {
                            return onPayload?.(data.value, data.model);
                        }

                        if (name === "onResponse") {
                            return onResponse?.(data.value, data.model);
                        }

                        if (name === "onProviderStreamEvent") {
                            return onProviderStreamEvent?.(data.value, data.model);
                        }

                        throw new Error("Unsupported transport callback");
                    },
                },
                signal,
                REQUEST_TIMEOUT_MS,
            );

            if (!terminal || this.closed || signal?.aborted) {
                throw new Error("Provider host did not complete a valid terminal response");
            }

            return terminal;
        } catch (error) {
            if (release || !lane) {
                await this.retire(sessionId, slot);

                this.options.log?.(
                    "Provider host request failed; lane discarded (remote outcome may be unknown)",
                );
            }

            throw error;
        } finally {
            release?.();
            this.active--;

            slot.requests--;
            slot.lastUsed = performance.now();

            if (auxiliary) {
                await this.retire(sessionId, slot);
            } else if (
                !slot.requests &&
                !this.closed &&
                lane &&
                !lane.connection.dead &&
                !slot.retirement
            ) {
                if (this.options.idleTimeoutMs === 0) {
                    await this.retire(sessionId, slot);
                } else {
                    slot.idleTimer = setTimeout(() => {
                        if (!slot.requests && this.lanes.get(sessionId) === slot) {
                            void this.retire(sessionId, slot).catch(() => {
                                this.options.log?.("Provider host idle cleanup failed");
                            });
                        }
                    }, this.options.idleTimeoutMs!);
                    slot.idleTimer.unref();
                }
            }
        }
    }

    /** Explicit coordinated rebuild; never mixes a settings update into an active request. */
    async refresh(): Promise<void> {
        this.assertOpen();

        if (this.active || this.refreshing) {
            throw new Error("Provider host refresh requires idle request lanes");
        }

        this.refreshing = true;
        let candidate: Lane | undefined;

        try {
            if (this.catalogOpening) {
                await Promise.allSettled([this.catalogOpening]);
            }

            // One bounded standby catalog. It writes only its private temporary ModelsStore;
            // failed discovery cannot alter accepted providers, lanes or the durable cache.
            candidate = await this.spawn("catalog", true);
            const result = await candidate.connection.call("refresh");

            if (
                result.providers.map((p: ProviderDescription) => p.id).join() !==
                this.descriptions.map((p) => p.id).join()
            ) {
                throw new Error("Provider IDs changed; reopen and register the host explicitly");
            }

            this.assertOpen();
            await this.cache.replace(result.snapshot);
            this.assertOpen();
            const previous = this.catalog;

            this.catalog = candidate;
            candidate = undefined;
            this.fingerprint = result.fingerprint;

            for (const description of this.descriptions) {
                Object.assign(
                    description,
                    result.providers.find((p: ProviderDescription) => p.id === description.id),
                );
            }

            await Promise.allSettled([...this.lanes].map(([id, slot]) => this.retire(id, slot)));
            await Promise.allSettled([...this.retiring]);

            if (previous) {
                await this.dispose(previous);
            }
        } catch (error) {
            if (candidate) {
                await this.dispose(candidate);
            }

            throw error;
        } finally {
            this.refreshing = false;
        }
    }

    private async dispose(lane: Lane): Promise<void> {
        await lane.connection.close();
        await rm(lane.root, { recursive: true, force: true });
        this.children.delete(lane);
    }

    async close(): Promise<void> {
        this.closed = true;

        for (const slot of this.lanes.values()) {
            clearTimeout(slot.idleTimer);
        }

        await Promise.allSettled([...this.children].map((lane) => this.dispose(lane)));
        await Promise.allSettled([...this.lanes.values()].map((slot) => slot.opening));
        await Promise.allSettled([...this.retiring]);

        if (this.catalogOpening) {
            await Promise.allSettled([this.catalogOpening]);
        }

        await Promise.allSettled([...this.opening]);
        await Promise.allSettled([...this.children].map((lane) => this.dispose(lane)));
        this.lanes.clear();
    }
}
