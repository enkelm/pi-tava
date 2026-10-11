/** Startup-only ownership of package hosts and their native provider registrations. */
import type { ModelRuntime } from "@earendil-works/pi-coding-agent";
import { PiProviderHost } from "./pi-provider-host.ts";
import { ProviderPackages, type ProviderPackageStartup } from "./provider-packages.ts";

export class ProviderExtensions {
    readonly #packages: ProviderPackages;
    readonly #models: ModelRuntime;
    readonly #authPath: string;
    readonly #report: (message: string) => void;
    readonly #hosts = new Map<PiProviderHost, string[]>();
    #recoveryRequired = false;

    /** A failed activation without a usable retained release holds all Durable progress until restart. */
    get recoveryRequired(): boolean {
        return this.#recoveryRequired;
    }

    constructor(
        packages: ProviderPackages,
        models: ModelRuntime,
        authPath: string,
        report: (message: string) => void,
    ) {
        this.#packages = packages;
        this.#models = models;
        this.#authPath = authPath;
        this.#report = report;
    }

    async open(): Promise<void> {
        try {
            const selections = await this.#packages.startup();

            await this.#activate(selections);

            if (this.#holdForCatalogSetup()) {
                return;
            }

            this.#packages.markStartupApplied();
        } catch {
            await this.#dispose();
            this.#packages.markStartupFailed();

            try {
                const fallback = await this.#packages.fallbackStartup();

                if (fallback.length > 0) {
                    await this.#activate(fallback);

                    if (this.#holdForCatalogSetup()) {
                        return;
                    }

                    this.#packages.markStartupFallbackApplied();
                    this.#report(
                        "Requested provider packages failed to start; retained releases are running. Use Providers to roll back or change the selection.",
                    );

                    return;
                }
            } catch {
                await this.#dispose();
            }

            // Keep owner recovery controls available. Never resume against a missing provider.
            this.#recoveryRequired = true;
            this.#report(
                "Pi provider compatibility is unavailable; Durable work is paused. Open Providers to disable or roll back the requested packages, then restart.",
            );
        }
    }

    /** Keep native sign-in available during bootstrap, but never resume work against an empty catalog. */
    #holdForCatalogSetup(): boolean {
        if (
            ![...this.#hosts.keys()].some((host) =>
                host.getProviders().some((provider) => provider.getModels().length === 0),
            )
        ) {
            return false;
        }

        this.#recoveryRequired = true;
        this.#packages.markStartupFailed();
        this.#report(
            "Provider sign-in or chat model discovery is needed; Durable work is paused. Use Providers, then restart.",
        );

        return true;
    }

    async #activate(selections: ProviderPackageStartup[]): Promise<void> {
        for (const selection of selections) {
            const host = await PiProviderHost.open({
                packageRoot: selection.root,
                agentDir: selection.agentDir,
                authPath: this.#authPath,
                modelsStorePath: selection.modelsStorePath,
                profile: selection.profile,
                providerIds: selection.providerIds,
                log: this.#report,
            });
            const providers = host.getProviders();
            const ids: string[] = [];

            this.#hosts.set(host, ids);

            for (const provider of providers) {
                if (this.#models.getProvider(provider.id) !== undefined) {
                    throw new Error("A hosted provider conflicts with an existing provider.");
                }

                this.#models.registerNativeProvider(provider);
                ids.push(provider.id);
            }

            const refreshed = await this.#models.refresh({
                providers: ids,
                allowNetwork: false,
            });

            if (refreshed.aborted || refreshed.errors.size > 0) {
                throw new Error("Hosted provider catalog initialization failed.");
            }

            await this.#models.getAvailable();
        }
    }

    owns(providerId: string): boolean {
        return [...this.#hosts.values()].some((ids) => ids.includes(providerId));
    }

    /** Owner-requested catalog refresh; no change to the selected package release or settings. */
    async refresh(providerId: string): Promise<void> {
        for (const [host, ids] of this.#hosts) {
            if (!ids.includes(providerId)) {
                continue;
            }

            await host.refresh();

            const result = await this.#models.refresh({
                providers: ids,
                allowNetwork: false,
            });

            if (result.aborted || result.errors.size > 0) {
                throw new Error("Hosted provider refresh failed.");
            }

            await this.#models.getAvailable();
        }
    }

    async #dispose(): Promise<void> {
        const hosts = [...this.#hosts.entries()];

        this.#hosts.clear();
        await Promise.allSettled(hosts.map(([host]) => host.close()));

        for (const [, ids] of hosts) {
            for (const id of ids) {
                this.#models.unregisterProvider(id);
            }
        }
    }

    /** Called after Harness.close has stopped and joined all model work. */
    async close(): Promise<void> {
        await this.#dispose();
        await this.#packages.close();
    }
}
