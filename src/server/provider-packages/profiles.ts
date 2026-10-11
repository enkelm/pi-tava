import type { ProviderPackageSettings } from "../config.ts";

export interface ProviderCompatibilityProfile {
    id: "litellm" | "native";
    packageName: string;
    supportsVersion(version: string): boolean;
    providerIds(settings: ProviderPackageSettings): string[];
    workerSettings(settings: ProviderPackageSettings): Record<string, unknown>;
}

/** Compatibility is an eligibility check, not proof that package hooks are safe to execute. */
const PROFILES: ProviderCompatibilityProfile[] = [
    {
        id: "litellm",
        packageName: "pi-provider-litellm",
        supportsVersion: (version) =>
            /^4\.(?:[2-9]|[1-9]\d+)\.\d+(?:\+[0-9A-Za-z.-]+)?$/.test(version),
        providerIds: (settings) => ["litellm", ...Object.keys(settings.aliases ?? {})],
        workerSettings: (settings) => ({
            litellm: {
                mcp: { enabled: false },
                skills: { enabled: false },
                budget: { enabled: false },
                providers: Object.fromEntries([
                    ["litellm", settings.baseUrl ? { baseUrl: settings.baseUrl } : {}],
                    ...Object.entries(settings.aliases ?? {}).map(([name, baseUrl]) => [
                        name,
                        { baseUrl },
                    ]),
                ]),
            },
        }),
    },
];

export function compatibilityProfile(
    name: string,
    version: string,
): ProviderCompatibilityProfile | undefined {
    return PROFILES.find(
        (profile) => profile.packageName === name && profile.supportsVersion(version),
    );
}

export function compatibilityReason(name: string): string {
    return PROFILES.some((profile) => profile.packageName === name)
        ? "This version is outside the supported native chat/API-key profile (>=4.2.0, <5)."
        : "No supported provider-host compatibility profile. Pi extension installation alone is not compatibility.";
}

/** Strict allowlist: never accept API keys, custom headers, command helpers or arbitrary settings. */
export function publicSettings(input: unknown): ProviderPackageSettings {
    if (!input || typeof input !== "object" || Array.isArray(input)) {
        throw new Error("Provider settings must be an object.");
    }

    const record = input as Record<string, unknown>;

    if (Object.keys(record).some((key) => key !== "baseUrl" && key !== "aliases")) {
        throw new Error(
            "Only public baseUrl and aliases settings are supported; credentials belong in provider auth.",
        );
    }

    const result: ProviderPackageSettings = {};

    if (record.baseUrl !== undefined) {
        result.baseUrl = publicUrl(record.baseUrl);
    }

    if (record.aliases !== undefined) {
        if (
            !record.aliases ||
            typeof record.aliases !== "object" ||
            Array.isArray(record.aliases)
        ) {
            throw new Error("Aliases must map provider IDs to public URLs.");
        }

        const entries = Object.entries(record.aliases);

        if (entries.length > 20) {
            throw new Error("At most 20 provider aliases are supported.");
        }

        result.aliases = Object.fromEntries(
            entries.map(([name, value]) => {
                if (
                    !/^[a-z][a-z0-9_-]{0,63}$/.test(name) ||
                    ["litellm", "constructor", "prototype", "__proto__"].includes(name)
                ) {
                    throw new Error("Invalid provider alias ID.");
                }

                return [name, publicUrl(value)];
            }),
        );
    }

    return result;
}

function publicUrl(input: unknown): string {
    if (typeof input !== "string" || input.length > 2048) {
        throw new Error("Expected a public HTTPS URL.");
    }

    let url: URL;

    try {
        url = new URL(input);
    } catch {
        throw new Error("Expected a public HTTPS URL.");
    }

    if (url.protocol !== "https:" || url.username || url.password || url.search || url.hash) {
        throw new Error(
            "Use a public HTTPS URL without credentials, query parameters or fragments.",
        );
    }

    return url.toString().replace(/\/$/, "");
}
