/** Owner-only package discovery and explicit restart-only provider selections. */
import { HttpError } from "../errors.ts";
import { publicSettings } from "../provider-packages/profiles.ts";
import { type ApiRequest, json, readJson } from "./io.ts";

export async function providerPackageRoutes(api: ApiRequest): Promise<void> {
    const { app, request, response, user } = api;

    if (user.role !== "owner") {
        throw new HttpError(403, "Only the owner can manage provider packages.");
    }

    const snapshot = async () => ({
        ...(await app.providerPackages.list()),
        recoveryRequired: app.providerExtensions.recoveryRequired,
    });

    if (request.method === "GET") {
        return json(response, 200, await snapshot());
    }

    if (request.method !== "POST") {
        throw new HttpError(404, "Unknown provider package route.");
    }

    const body = await readJson<Record<string, unknown>>(request);

    if (body === null || typeof body !== "object" || Array.isArray(body)) {
        throw new HttpError(400, "Expected provider package options.");
    }

    const text = (key: string): string => {
        const value = body[key];

        if (typeof value !== "string" || value.length === 0 || value.length > 512) {
            throw new HttpError(400, `Provide a valid ${key}.`);
        }

        return value;
    };

    const enabled = (): boolean => {
        if (typeof body.enabled !== "boolean") {
            throw new HttpError(400, "enabled must be true or false.");
        }

        return body.enabled;
    };

    const trust = (): void => {
        if (body.trusted !== true) {
            throw new HttpError(
                400,
                "Confirm that you trust this package to run with the server's rights.",
            );
        }
    };

    const packages = app.providerPackages;

    try {
        switch (body.action) {
            case "module":
                await app.setExtensionEnabled(user, "pi-providers.ts", enabled());
                break;
            case "select":
                trust();
                await packages.selectInstalled(text("id"));
                break;
            case "install":
                trust();
                await packages.install(text("source"));
                break;

            case "enable": {
                const selected = enabled();

                if (selected) {
                    trust();
                }

                await packages.setEnabled(text("name"), selected);
                break;
            }

            case "configure": {
                const settings = publicSettings(body.settings);

                for (const id of Object.keys(settings.aliases ?? {})) {
                    if (app.models.getProvider(id) && !app.providerExtensions.owns(id)) {
                        throw new HttpError(
                            400,
                            "A provider alias conflicts with an existing provider.",
                        );
                    }
                }

                await packages.configure(text("name"), settings);
                break;
            }

            case "update":
                trust();
                await packages.update(text("name"));
                break;
            case "rollback":
                await packages.rollback(text("name"));
                break;
            default:
                throw new HttpError(400, "Unknown provider package action.");
        }
    } catch (error) {
        if (error instanceof HttpError) {
            throw error;
        }

        const snapshot = await packages.list().catch(() => undefined);

        // npm/registry diagnostics and provider exceptions can include credential-bearing URLs.
        throw new HttpError(
            snapshot?.busy ? 409 : 400,
            snapshot?.busy
                ? "Another provider package operation is in progress."
                : "Provider package action failed. Check compatibility and the requested options; running packages were not changed.",
        );
    }

    return json(response, 200, await snapshot());
}
