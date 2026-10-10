/** Owner-only discovery and explicit app-wide browser-profile migration. */
import { BrowserError } from "../browser/cdp.ts";
import { HttpError } from "../errors.ts";
import { type ApiRequest, json, readJson } from "./io.ts";

export async function browserProfileRoutes(api: ApiRequest, action?: string): Promise<void> {
    const { app, request, response, user } = api;

    if (user.role !== "owner") {
        throw new HttpError(403, "Only the owner can manage browser profiles.");
    }

    const profiles = app.browsers.profiles;

    try {
        if (request.method === "GET" && action === undefined) {
            return json(response, 200, {
                profiles: await profiles.discover(),
                defaultProfile: profiles.current() ?? null,
            });
        }

        if (request.method !== "POST" || !["discover", "default"].includes(action ?? "")) {
            throw new HttpError(404, "Unknown browser profile route");
        }

        const body = await readJson<Record<string, unknown>>(request);

        if (body === null || typeof body !== "object" || Array.isArray(body)) {
            throw new HttpError(400, "Expected browser profile options.");
        }

        if (action === "discover") {
            if (typeof body.path !== "string" || typeof body.executable !== "string") {
                throw new HttpError(
                    400,
                    "Provide a profile path and its Chromium-based browser executable.",
                );
            }

            return json(response, 200, {
                profiles: await profiles.discover({ path: body.path, executable: body.executable }),
                defaultProfile: profiles.current() ?? null,
            });
        }

        const id = body.id;

        if (body.confirm !== true || (id !== null && typeof id !== "string")) {
            throw new HttpError(400, "Confirm the app-wide profile change first.");
        }

        await app.browsers.setDefaultProfile(id);

        return json(response, 200, { defaultProfile: profiles.current() ?? null });
    } catch (error) {
        if (error instanceof BrowserError) {
            throw new HttpError(409, error.message);
        }

        throw error;
    }
}
