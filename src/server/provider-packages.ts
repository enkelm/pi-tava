import { createHash, randomUUID } from "node:crypto";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { mkdir, readFile, realpath, rename, rm, stat, writeFile } from "node:fs/promises";
import { join, relative, isAbsolute, basename } from "node:path";
import { DefaultPackageManager, SettingsManager } from "@earendil-works/pi-coding-agent";
import type {
    ConfigStore,
    ProviderPackageRelease,
    ProviderPackageSelection,
    ProviderPackageSettings,
    ProviderPackageState,
} from "./config.ts";
import { installPackage } from "./provider-packages/install.ts";
import {
    compatibilityProfile,
    compatibilityReason,
    publicSettings,
} from "./provider-packages/profiles.ts";

/** A virtual restart-only builtin; never put this file in the watched extension directory. */
export const PI_PROVIDERS_FILE = "pi-providers.ts";
const capture = promisify(execFile);
const NAME = /^(?:@[a-z0-9][a-z0-9._-]*\/)?[a-z0-9][a-z0-9._-]*$/;
const VERSION =
    /^(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$/;

export interface ProviderDiscoveryRow {
    id: string;
    name: string;
    version: string;
    source: string;
    compatible: boolean;
    reason?: string;
}

export interface ProviderPackageRow extends ProviderDiscoveryRow {
    activeVersion?: string;
    previousVersion?: string;
    installedVersion?: string;
    settings: ProviderPackageSettings;
    enabled: boolean;
    active: boolean;
    status: "active" | "staged" | "disabled" | "unavailable";
}

export interface ProviderPackagesSnapshot {
    enabled: boolean;
    activeEnabled: boolean;
    restartRequired: boolean;
    busy?: string;
    packages: ProviderPackageRow[];
    available: ProviderDiscoveryRow[];
    error?: string;
}

export interface ProviderPackageStartup {
    name: string;
    version: string;
    root: string;
    agentDir: string;
    /** Durable Coop-owned catalog store, scoped to this release and public worker configuration. */
    modelsStorePath: string;
    profile: "litellm" | "native";
    providerIds: string[];
    previous?: Omit<ProviderPackageStartup, "previous">;
}

interface Manifest {
    name: string;
    version: string;
    pi?: { extensions?: unknown };
}

interface Discovery extends ProviderDiscoveryRow {
    root: string;
}

/** Owner-controlled immutable installs. Discovery/startup never install or execute extension code. */
export class ProviderPackages {
    #config: ConfigStore;
    #directory: string;
    #agentDir: string;
    #active: NonNullable<ProviderPackageState["applied"]> = { enabled: false, packages: [] };
    #startup?: NonNullable<ProviderPackageState["applied"]>;
    #fallback?: NonNullable<ProviderPackageState["applied"]>;
    #started = false;
    #busy?: string;
    #error?: string;
    #operation?: Promise<ProviderPackagesSnapshot>;
    #registry = new AbortController();
    #installer = new AbortController();
    #closed = false;
    #hostDirs = new Set<string>();

    constructor(config: ConfigStore, dataDir: string, agentDir: string) {
        this.#config = config;
        this.#directory = join(dataDir, "provider-packages");
        this.#agentDir = agentDir;
    }

    /** Safe for the shared Extensions row: in-memory flags only, never installed-package discovery. */
    moduleState(): Pick<
        ProviderPackagesSnapshot,
        "enabled" | "activeEnabled" | "restartRequired" | "error" | "busy"
    > {
        const state = this.#config.providerPackages;
        const enabled = this.#enabled();

        return {
            enabled,
            activeEnabled: this.#active.enabled,
            restartRequired:
                enabled !== this.#active.enabled ||
                selectionKey(state.packages) !== selectionKey(this.#active.packages),
            busy: this.#busy,
            error: this.#error,
        };
    }

    async list(): Promise<ProviderPackagesSnapshot> {
        let discoveries: Discovery[] = [];
        let discoveryError: string | undefined;

        try {
            discoveries = await this.#discover();
        } catch {
            discoveryError =
                "Installed Pi package metadata could not be read; retained pi-tava selections are still available.";
        }

        const state = this.#config.providerPackages;
        const module = this.moduleState();
        const packages: ProviderPackageRow[] = [];

        for (const selection of state.packages) {
            const active = this.#active.packages.find((item) => item.name === selection.name);
            const profile = compatibilityProfile(selection.name, selection.release.version);
            let available = false;
            let settings: ProviderPackageSettings = {};

            try {
                await this.#verify(selection.name, selection.release);
                settings = publicSettings(selection.settings ?? {});
                available = true;
            } catch {
                // List remains useful for owner recovery from missing/corrupt installations.
            }

            packages.push({
                id: selection.release.id,
                name: selection.name,
                version: selection.release.version,
                source: selection.release.source,
                activeVersion:
                    this.#active.enabled && active?.enabled ? active.release.version : undefined,
                previousVersion: rollbackTarget(state, selection)?.release.version,
                installedVersion: discoveries.find((item) => item.name === selection.name)?.version,
                settings,
                enabled: selection.enabled,
                active: this.#active.enabled && active?.enabled === true,
                compatible: profile !== undefined && available,
                reason: !available
                    ? "Retained installation or public configuration is missing or invalid."
                    : profile
                      ? undefined
                      : compatibilityReason(selection.name),
                status: !available
                    ? "unavailable"
                    : !selection.enabled
                      ? "disabled"
                      : this.#active.enabled &&
                          active?.enabled &&
                          active.release.id === selection.release.id
                        ? "active"
                        : "staged",
            });
        }

        return {
            ...module,
            error: module.error ?? discoveryError,
            packages,
            available: discoveries.map(({ root: _root, ...row }) => row),
        };
    }

    async setModuleEnabled(enabled: boolean): Promise<ProviderPackagesSnapshot> {
        this.#idle();
        this.#boolean(enabled);
        this.#config.setExtensionEnabled(PI_PROVIDERS_FILE, enabled);

        return this.list();
    }

    async setEnabled(name: string, enabled: boolean): Promise<ProviderPackagesSnapshot> {
        this.#idle();
        this.#boolean(enabled);
        const state = this.#config.providerPackages;

        this.#selection(state, name).enabled = enabled;
        this.#config.providerPackages = state;

        return this.list();
    }

    async configure(
        name: string,
        settings: ProviderPackageSettings,
    ): Promise<ProviderPackagesSnapshot> {
        this.#idle();
        const safe = publicSettings(settings);
        const state = this.#config.providerPackages;

        this.#selection(state, name).settings = safe;
        this.#config.providerPackages = state;

        return this.list();
    }

    async selectInstalled(id: string): Promise<ProviderPackagesSnapshot> {
        return this.#run("Importing installed package", async () => {
            const discovery = (await this.#discover()).find((item) => item.id === id);

            if (!discovery) {
                throw new Error("Installed package selection has expired; refresh the list.");
            }

            if (!discovery.compatible) {
                throw new Error(discovery.reason);
            }

            // Never copy source or mutate ordinary Pi's tree: import via an exact immutable install.
            await this.#stage(discovery.source);
        });
    }

    async stage(input: { source: string; name?: string }): Promise<ProviderPackagesSnapshot> {
        return this.#run("Staging provider package", async () => {
            const spec = exactSpec(input.source);

            if (input.name !== undefined && input.name !== spec.name) {
                throw new Error("Package name does not match the npm source.");
            }

            await this.#stage(input.source);
        });
    }

    async install(source: string): Promise<ProviderPackagesSnapshot> {
        return this.stage({ source });
    }

    async update(name: string): Promise<ProviderPackagesSnapshot> {
        return this.#run("Checking provider update", async () => {
            const current = this.#selection(this.#config.providerPackages, name);
            const command = await this.#npmCommand();
            let version: unknown;

            try {
                const { stdout } = await capture(
                    command[0]!,
                    [...command.slice(1), "view", name, "dist-tags.latest", "--json"],
                    {
                        cwd: this.#directory,
                        timeout: 30_000,
                        maxBuffer: 64 * 1024,
                        signal: this.#registry.signal,
                    },
                );

                version = JSON.parse(stdout);
            } catch {
                throw new Error(
                    "Unable to read the latest package version; no selection was changed.",
                );
            }

            if (typeof version !== "string" || !VERSION.test(version)) {
                throw new Error("Registry did not return an exact package version.");
            }

            if (!compatibilityProfile(name, version)) {
                throw new Error(compatibilityReason(name));
            }

            if (newer(version, current.release.version)) {
                await this.#stage(`npm:${name}@${version}`);
            }
        });
    }

    async rollback(name: string): Promise<ProviderPackagesSnapshot> {
        return this.#run("Selecting retained provider release", async () => {
            const state = this.#config.providerPackages;
            const selection = this.#selection(state, name);

            const target = rollbackTarget(state, selection);

            if (!target) {
                throw new Error("No retained previous release is available.");
            }

            await this.#verify(name, target.release);

            if (this.#closed) {
                throw new Error("Provider rollback was closed; no selection was changed.");
            }

            const release = selection.release;

            selection.release = target.release;
            selection.previous = release;

            if (target.fromApplied) {
                selection.settings = publicSettings(target.settings ?? {});
            }

            this.#config.providerPackages = state;
        });
    }

    /** Metadata preparation only. The host must activate every selection before markStartupApplied. */
    async startup(): Promise<ProviderPackageStartup[]> {
        this.#idle();

        if (this.#started) {
            throw new Error(
                "Provider packages activate only once per process; restart to apply changes.",
            );
        }

        this.#started = true;
        const state = this.#config.providerPackages;
        const enabled = this.#enabled();
        const results: ProviderPackageStartup[] = [];

        try {
            if (enabled) {
                const providerIds = new Set<string>();

                for (const selection of state.packages.filter((item) => item.enabled)) {
                    const prepared = await this.#prepare(selection, selection.release);

                    for (const id of prepared.providerIds) {
                        if (providerIds.has(id)) {
                            throw new Error("Selected packages contain conflicting provider IDs.");
                        }

                        providerIds.add(id);
                    }

                    if (selection.previous) {
                        try {
                            prepared.previous = await this.#prepare(selection, selection.previous);
                        } catch {
                            // Missing rollback metadata must never substitute for the desired release.
                        }
                    }

                    results.push(prepared);
                }
            }

            this.#startup = { enabled, packages: structuredClone(state.packages) };
        } catch {
            this.#error =
                "Provider startup metadata validation failed; retained selections were not activated.";

            throw new Error(this.#error);
        }

        return results;
    }

    /** Called by the app only after the real provider host's activation gate succeeds. */
    markStartupApplied(): void {
        if (this.#closed || !this.#startup) {
            throw new Error("No prepared provider startup is available.");
        }

        this.#active = this.#startup;
        this.#startup = undefined;
        const state = this.#config.providerPackages;

        state.applied = structuredClone(this.#active);
        this.#config.providerPackages = state;
    }

    /** Runtime activation failed. Keep desired pins/configuration intact for owner recovery. */
    markStartupFailed(): void {
        this.#startup = undefined;
        this.#fallback = undefined;
        this.#error =
            "Requested provider activation failed; restart or select a retained release to recover.";
    }

    /** Prepare the complete last successfully applied configuration, not just the last staged release. */
    async fallbackStartup(): Promise<ProviderPackageStartup[]> {
        this.#idle();
        const applied = this.#config.providerPackages.applied;

        if (!this.#enabled() || !applied?.enabled) {
            return [];
        }

        const results: ProviderPackageStartup[] = [];

        try {
            for (const selection of applied.packages.filter((item) => item.enabled)) {
                results.push(await this.#prepare(selection, selection.release));
            }
        } catch {
            this.#fallback = undefined;
            this.#error =
                "Requested and last-applied provider installations are unavailable; owner recovery is required.";

            throw new Error(this.#error);
        }

        this.#fallback = structuredClone(applied);

        return results;
    }

    /** The app has activated the fallback hosts; never overwrite the owner's desired selection. */
    markStartupFallbackApplied(): void {
        if (this.#closed || !this.#fallback) {
            throw new Error("No prepared provider fallback is available.");
        }

        this.#active = this.#fallback;
        this.#fallback = undefined;
        this.#startup = undefined;
        this.#error =
            "Requested provider activation failed; the last applied configuration is running. Restart required.";
    }

    async close(): Promise<void> {
        this.#closed = true;
        this.#registry.abort();
        this.#installer.abort();
        await this.#operation?.catch(() => {});
        await Promise.all(
            [...this.#hostDirs].map((directory) => rm(directory, { recursive: true, force: true })),
        );
        this.#hostDirs.clear();
    }

    #enabled(): boolean {
        return this.#config.extensionChoice(PI_PROVIDERS_FILE) === true;
    }

    #idle(): void {
        if (this.#closed) {
            throw new Error("Provider package controller is closed.");
        }

        if (this.#busy) {
            throw new Error("Another provider package operation is in progress.");
        }
    }

    #boolean(value: boolean): void {
        if (typeof value !== "boolean") {
            throw new Error("Enabled must be a boolean.");
        }
    }

    #selection(state: ProviderPackageState, name: string): ProviderPackageSelection {
        const selection = state.packages.find((item) => item.name === name);

        if (!selection) {
            throw new Error("Unknown selected provider package.");
        }

        return selection;
    }

    async #run(label: string, action: () => Promise<void>): Promise<ProviderPackagesSnapshot> {
        this.#idle();
        this.#busy = label;
        this.#error = undefined;
        const operation = (async () => {
            try {
                await action();
            } catch (error) {
                // External command diagnostics may include registry credentials. Never expose them.
                this.#error =
                    "Provider package operation failed; saved selection and active installation were preserved.";

                throw error;
            } finally {
                this.#busy = undefined;
            }

            return this.list();
        })();

        this.#operation = operation;

        try {
            return await operation;
        } finally {
            this.#operation = undefined;
        }
    }

    async #globalSettings(): Promise<SettingsManager> {
        let input: Record<string, unknown> = {};

        try {
            input = await jsonFile(join(this.#agentDir, "settings.json"));
        } catch (error) {
            if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
                throw new Error("Unable to read ordinary Pi's package settings.");
            }
        }

        // An in-memory copy avoids writing/migrating ordinary Pi settings and excludes project data.
        return SettingsManager.inMemory({
            packages: Array.isArray(input.packages)
                ? input.packages.filter((item) => {
                      const source = typeof item === "string" ? item : item?.source;

                      return typeof source === "string" && npmName(source) !== undefined;
                  })
                : [],
            npmCommand:
                Array.isArray(input.npmCommand) &&
                input.npmCommand.every((item) => typeof item === "string")
                    ? input.npmCommand
                    : undefined,
        });
    }

    async #discover(): Promise<Discovery[]> {
        const settings = await this.#globalSettings();
        const manager = new DefaultPackageManager({
            cwd: this.#directory,
            agentDir: this.#agentDir,
            settingsManager: settings,
        });
        const discoveries: Discovery[] = [];

        // This public boundary only resolves installed roots; never call resolve() (which may install).
        for (const item of manager
            .listConfiguredPackages()
            .filter((item) => item.scope === "user")) {
            const name = npmName(item.source);

            if (!name || !item.installedPath) {
                continue;
            }

            try {
                const root = await realpath(item.installedPath);
                const manifest = await packageManifest(root);

                if (
                    manifest.name !== name ||
                    !manifest.pi ||
                    !Array.isArray(manifest.pi.extensions)
                ) {
                    continue;
                }

                const compatible = compatibilityProfile(name, manifest.version) !== undefined;
                const source = `npm:${name}@${manifest.version}`;
                const id = createHash("sha256").update(`${root}\0${source}`).digest("hex");

                if (!discoveries.some((discovery) => discovery.id === id)) {
                    discoveries.push({
                        id,
                        name,
                        version: manifest.version,
                        source,
                        root,
                        compatible,
                        reason: compatible ? undefined : compatibilityReason(name),
                    });
                }
            } catch {
                // Broken/uninstalled packages are not selectable. No executable module is imported.
            }
        }

        return discoveries;
    }

    async #npmCommand(): Promise<string[]> {
        const requested = (await this.#globalSettings()).getNpmCommand();
        const configured = requested?.length ? requested : ["npm"];

        // Only npm currently guarantees our retained package-lock and script/peer policy.
        if (!configured[0] || !/^npm(?:\.cmd|\.exe)?$/.test(basename(configured[0]))) {
            throw new Error("Provider staging currently requires npm as Pi's npmCommand.");
        }

        return [
            ...configured,
            "--ignore-scripts",
            "--legacy-peer-deps",
            "--global=false",
            "--no-audit",
            "--no-fund",
            "--save-exact",
            "--package-lock=true",
        ];
    }

    async #stage(source: string): Promise<void> {
        if (this.#closed) {
            throw new Error("Provider staging was closed; no selection was changed.");
        }

        const { name, version } = exactSpec(source);

        if (!compatibilityProfile(name, version)) {
            throw new Error(compatibilityReason(name));
        }

        const id = randomUUID();
        const staging = join(this.#directory, "staging", id);
        const release = join(this.#directory, "releases", id);
        let retained = false;

        await mkdir(staging, { recursive: true, mode: 0o700 });

        try {
            await installPackage(
                { source, directory: staging, npmCommand: await this.#npmCommand() },
                this.#installer.signal,
            );

            const root = join(staging, "npm", "node_modules", name);

            await contained(staging, root);
            await validateRelease(root, name, version);
            await verifyLock(join(staging, "npm", "package-lock.json"), name, version);

            if (this.#closed) {
                throw new Error("Provider staging was closed; no selection was changed.");
            }

            await mkdir(join(this.#directory, "releases"), { recursive: true, mode: 0o700 });
            await rename(staging, release);
            retained = true;

            if (this.#closed) {
                throw new Error("Provider staging was closed; no selection was changed.");
            }

            const state = this.#config.providerPackages;
            const existing = state.packages.find((selection) => selection.name === name);
            const next: ProviderPackageRelease = { id, version, source };

            if (existing) {
                existing.previous = existing.release;
                existing.release = next;
            } else {
                state.packages.push({ name, enabled: true, release: next });
            }

            this.#config.providerPackages = state;
        } finally {
            // Only our unselected staging tree is removed. Complete releases/lockfiles are retained.
            if (!retained) {
                await rm(staging, { recursive: true, force: true });
            }
        }
    }

    async #verify(name: string, release: ProviderPackageRelease): Promise<string> {
        if (!/^[0-9a-f-]{36}$/.test(release.id)) {
            throw new Error("Invalid retained release identity.");
        }

        const spec = exactSpec(release.source);

        if (spec.name !== name || spec.version !== release.version) {
            throw new Error("Retained release metadata does not match the selection.");
        }

        const directory = join(this.#directory, "releases", release.id);
        const root = join(directory, "npm", "node_modules", name);

        await contained(directory, root);
        await validateRelease(root, name, release.version);
        await verifyLock(join(directory, "npm", "package-lock.json"), name, release.version);

        return root;
    }

    async #prepare(
        selection: ProviderPackageSelection,
        release: ProviderPackageRelease,
    ): Promise<ProviderPackageStartup> {
        const root = await this.#verify(selection.name, release);
        const profile = compatibilityProfile(selection.name, release.version);

        if (!profile) {
            throw new Error(compatibilityReason(selection.name));
        }

        const settings = publicSettings(selection.settings ?? {});
        const workerSettings = {
            packages: [],
            extensions: [],
            ...profile.workerSettings(settings),
        };
        const cacheKey = createHash("sha256")
            .update(
                canonicalJson({
                    name: selection.name,
                    release: { id: release.id, version: release.version, source: release.source },
                    profile: profile.id,
                    settings: workerSettings,
                }),
            )
            .digest("hex");
        const cacheDir = join(this.#directory, "model-cache", cacheKey);
        const modelsStorePath = join(cacheDir, "models.json");

        // Only public configuration participates in the cache key; credentials stay in shared auth.
        await mkdir(cacheDir, { recursive: true, mode: 0o700 });
        // Configuration snapshots are separate from immutable code releases and ordinary Pi's home.
        const hostDir = join(this.#directory, "hosts", randomUUID());
        const agentDir = join(hostDir, "agent");

        this.#hostDirs.add(hostDir);
        await mkdir(agentDir, { recursive: true, mode: 0o700 });
        await writeFile(join(agentDir, "settings.json"), `${canonicalJson(workerSettings)}\n`, {
            mode: 0o600,
        });

        return {
            name: selection.name,
            version: release.version,
            root,
            agentDir,
            modelsStorePath,
            profile: profile.id,
            providerIds: profile.providerIds(settings),
        };
    }
}

function exactSpec(source: string): { name: string; version: string } {
    if (typeof source !== "string" || source.length > 300 || !source.startsWith("npm:")) {
        throw new Error("Use an exact npm source, for example npm:pi-provider-litellm@4.2.0.");
    }

    const spec = source.slice(4);
    const separator = spec.lastIndexOf("@");
    const name = spec.slice(0, separator);
    const version = spec.slice(separator + 1);

    if (separator < 1 || !NAME.test(name) || !VERSION.test(version)) {
        throw new Error(
            "Only exact npm package versions are accepted; no tags, ranges, git or file paths.",
        );
    }

    return { name, version };
}

function npmName(source: string): string | undefined {
    if (!source.startsWith("npm:") || source.length > 300) {
        return undefined;
    }

    const spec = source.slice(4);
    const separator = spec.lastIndexOf("@");
    const name = separator > 0 ? spec.slice(0, separator) : spec;
    const version = separator > 0 ? spec.slice(separator + 1) : "";

    return NAME.test(name) && (!version || /^[0-9A-Za-z.*^~<>=| -]+$/.test(version))
        ? name
        : undefined;
}

async function jsonFile(file: string): Promise<Record<string, any>> {
    const metadata = await stat(file);

    if (!metadata.isFile() || metadata.size > 512 * 1024) {
        throw new Error("Package metadata is not a bounded JSON file.");
    }

    const value: unknown = JSON.parse(await readFile(file, "utf8"));

    if (!value || typeof value !== "object" || Array.isArray(value)) {
        throw new Error("Invalid package metadata.");
    }

    return value as Record<string, any>;
}

async function packageManifest(root: string): Promise<Manifest> {
    const manifest = await jsonFile(join(root, "package.json"));

    if (
        typeof manifest.name !== "string" ||
        !NAME.test(manifest.name) ||
        typeof manifest.version !== "string" ||
        !VERSION.test(manifest.version)
    ) {
        throw new Error("Invalid installed package identity.");
    }

    return manifest as Manifest;
}

async function contained(directory: string, file: string): Promise<void> {
    const path = relative(await realpath(directory), await realpath(file));

    if (path.startsWith("..") || isAbsolute(path)) {
        throw new Error("Package entry escapes its owned release.");
    }
}

async function validateRelease(root: string, name: string, version: string): Promise<void> {
    const manifest = await packageManifest(root);

    if (
        manifest.name !== name ||
        manifest.version !== version ||
        !Array.isArray(manifest.pi?.extensions) ||
        manifest.pi.extensions.length === 0 ||
        manifest.pi.extensions.length > 20
    ) {
        throw new Error("Installed package does not match its pinned extension manifest.");
    }

    for (const entry of manifest.pi.extensions) {
        if (typeof entry !== "string" || !/\.(?:ts|js|mjs|cjs)$/.test(entry) || isAbsolute(entry)) {
            throw new Error("Unsupported provider extension manifest entry.");
        }

        await contained(root, join(root, entry));

        if (!(await stat(join(root, entry))).isFile()) {
            throw new Error("Missing provider extension entry.");
        }
    }
}

async function verifyLock(file: string, name: string, version: string): Promise<void> {
    // npm lockfile records every physical dependency location, including nested copies.
    const lock = await jsonFile(file);
    const entries = lock.packages;

    if (!entries || typeof entries !== "object" || Array.isArray(entries)) {
        throw new Error("A complete npm dependency lockfile is required.");
    }

    if (entries[`node_modules/${name}`]?.version !== version) {
        throw new Error("Dependency lockfile does not match the exact selected release.");
    }

    for (const path of Object.keys(entries)) {
        if (
            /(?:^|\/)node_modules\/(?:@earendil-works|@mariozechner)\/pi-(?:ai|agent-core|coding-agent|tui)(?:$|\/)/.test(
                path,
            )
        ) {
            throw new Error(
                "Package installed a duplicate Pi host runtime instead of using host peers.",
            );
        }
    }
}

/** Object-key order in an owner request must not fork an otherwise identical configuration cache. */
function canonicalJson(value: unknown): string {
    return JSON.stringify(value, (_key, item: unknown) => {
        if (item && typeof item === "object" && !Array.isArray(item)) {
            return Object.fromEntries(
                Object.entries(item).sort(([left], [right]) =>
                    left < right ? -1 : left > right ? 1 : 0,
                ),
            );
        }

        return item;
    });
}

/** A staged predecessor may never have run; prefer the last actually applied complete config. */
function rollbackTarget(
    state: ProviderPackageState,
    selection: ProviderPackageSelection,
):
    | {
          release: ProviderPackageRelease;
          settings?: ProviderPackageSettings;
          fromApplied: boolean;
      }
    | undefined {
    const applied = state.applied?.enabled
        ? state.applied.packages.find((item) => item.name === selection.name && item.enabled)
        : undefined;

    if (applied && applied.release.id !== selection.release.id) {
        return { release: applied.release, settings: applied.settings, fromApplied: true };
    }

    return selection.previous ? { release: selection.previous, fromApplied: false } : undefined;
}

/** Rollback history is bookkeeping, not a change to running provider configuration. */
function selectionKey(packages: ProviderPackageSelection[]): string {
    return JSON.stringify(
        packages.map(({ name, enabled, release, settings }) => ({
            name,
            enabled,
            release,
            settings: settings ?? {},
        })),
    );
}

function newer(candidate: string, current: string): boolean {
    const next = candidate.split(/[+-]/)[0]!.split(".").map(Number);
    const old = current.split(/[+-]/)[0]!.split(".").map(Number);

    for (let index = 0; index < 3; index++) {
        if (next[index] !== old[index]) {
            return next[index]! > old[index]!;
        }
    }

    return false;
}
