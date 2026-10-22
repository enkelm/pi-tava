/**
 * `/api`: the routes the web app calls. Each needs a signed-in person, and each but a GET needs the `X-Pocket` header,
 * which a form on another site cannot send. A conversation's routes are in `conversation-routes.ts`.
 */
import { readdirSync, statSync } from "node:fs";
import type { IncomingMessage, ServerResponse } from "node:http";
import { homedir, networkInterfaces } from "node:os";
import { dirname, join } from "node:path";
import QRCode from "qrcode";
import { BACKGROUND_CONTEXT, withCancel } from "@earendil-works/chord/context";
import { parseWorkspaceLocation } from "../workspace-location.ts";
import { parseProjectAccess } from "../project-access.ts";
import { MAX_PEEKS } from "../app.ts";
import {
    type Auth,
    COOKIE,
    clearAuthCookie,
    INVITE_MINUTES,
    type InviteGrant,
    type InviteMinutes,
    origin,
    parseCookies,
    quickTunnelHost,
} from "../auth.ts";
import type { User } from "../config.ts";
import type { CreateSessionRequest, SessionPatch } from "../commands.ts";
import { HttpError } from "../errors.ts";
import { FileLists } from "../files.ts";
import { draftUploadDirectory } from "../agent-draft-uploads.ts";
import { receiveUpload } from "./uploads.ts";
import type { ImportRequest } from "../pi-sessions.ts";
import type { PrivateRequest } from "../private-sessions.ts";
import { runningNow } from "../running.ts";
import { MAX_AGENT_PROMPT_LENGTH } from "../thread-prompts.ts";
import { browserProfileRoutes } from "./browser-profile-routes.ts";
import { browserRoutes } from "./browser-routes.ts";
import { conversationRoutes } from "./conversation-routes.ts";
import { createEventStreams } from "./events.ts";
import { extensionRoute } from "./extension-routes.ts";
import {
    type ApiRequest,
    conversationId,
    type HttpOptions,
    json,
    readJson,
    withReadContext,
} from "./io.ts";
import { pushRoutes } from "./push-routes.ts";
import { providerPackageRoutes } from "./provider-package-routes.ts";

/** This machine's non-internal IPv4 addresses, for invite links other devices on its networks can open. */
function lanAddresses(): string[] {
    return Object.values(networkInterfaces())
        .flat()
        .filter((net) => net !== undefined && net.family === "IPv4" && !net.internal)
        .map((net) => net!.address);
}

/** The `/api` routes. Each HTTP handler makes its own, and its event streams live as long as it does. */
export function createApi(options: HttpOptions, auth: Auth) {
    const { app } = options;
    const { events, poll } = createEventStreams(app);
    const draftFiles = new FileLists();

    const requireUser = (request: IncomingMessage): User => {
        const user = auth.user(request);

        if (user === undefined) {
            throw new HttpError(401, "Sign in first");
        }

        // Config keeps mutable identities. Pin this request's credentials and grants before any
        // route awaits, so later authorization can detect token rotation instead of inheriting it.
        return structuredClone(user);
    };

    const requireOwner = (user: User): void => {
        if (user.role !== "owner") {
            throw new HttpError(403, "Only the owner can do that");
        }
    };

    /**
     * What an invite may grant: viewers and people invited to one session cannot invite anyone, and only the owner can
     * sign a device in as the owner (never for one session).
     */
    const inviteGrant = (
        user: User,
        body: {
            role?: unknown;
            session?: unknown;
            continuePiSessions?: unknown;
            projectAccess?: unknown;
        },
    ): InviteGrant => {
        requireOwner(user);

        if (body.continuePiSessions !== undefined && typeof body.continuePiSessions !== "boolean") {
            throw new HttpError(400, "continuePiSessions must be a boolean");
        }

        if (body.continuePiSessions === true) {
            throw new HttpError(400, "Project invitations cannot include host Pi history access");
        }

        if (body.role === "owner") {
            requireOwner(user);

            return { role: "owner" };
        }

        if (user.role === "viewer" || user.sessions !== undefined) {
            throw new HttpError(403, "Only people with access to every session can invite others.");
        }

        const role = body.role === "viewer" ? "viewer" : "guest";
        const projectAccess = parseProjectAccess(
            body.projectAccess === undefined ? {} : body.projectAccess,
        );

        if (body.session === undefined || body.session === null) {
            return {
                role,
                projectAccess,
            };
        }

        const session = conversationId(String(body.session));

        if (!app.sessions(user).some((each) => each.id === Number(session))) {
            throw new HttpError(400, "No such session");
        }

        return { role, session: String(session), projectAccess: {} };
    };

    /** How long an invite lasts, in minutes: one of `INVITE_MINUTES`, 15 when not said. */
    const inviteMinutes = (body: { minutes?: unknown }): InviteMinutes => {
        if (body.minutes === undefined) {
            return 15;
        }

        const minutes = INVITE_MINUTES.find((each) => each === body.minutes);

        if (minutes === undefined) {
            throw new HttpError(400, "An invite lasts 15 minutes, an hour, a day, or a week.");
        }

        return minutes;
    };

    /** A guest signed in by a cookie set on a Cloudflare quick tunnel can only come back through it: remember which one. */
    const noteTunnel = (request: IncomingMessage, user: User): void => {
        if (
            user.role === "owner" ||
            user.tunnel !== undefined ||
            !parseCookies(request.headers.cookie)[COOKIE]
        ) {
            return;
        }

        const tunnel = quickTunnelHost(request);

        if (tunnel !== undefined) {
            app.config.updateUser(user.id, { tunnel });
        }
    };

    return async (
        request: IncomingMessage,
        response: ServerResponse,
        url: URL,
        parts: string[],
    ): Promise<void> => {
        const method = request.method ?? "GET";
        const user = requireUser(request);

        noteTunnel(request, user);

        if (method !== "GET" && request.headers["x-pocket"] !== "1") {
            throw new HttpError(403, "Missing X-Pocket header");
        }

        const [first, second, third, fourth] = parts;
        const route: ApiRequest = { app, request, response, url, user };
        const providerRecoveryRoute =
            ["provider-packages", "providers", "auth", "restart"].includes(first ?? "") ||
            (first === "extensions" && second === "pi-providers.ts");

        // Durable progress calls resume its scheduler, not just the named conversation. During a
        // failed provider startup only read-only views and owner recovery/auth routes may run.
        if (method !== "GET" && app.providerExtensions.recoveryRequired && !providerRecoveryRoute) {
            throw new HttpError(
                503,
                "Durable work is paused after provider startup failed. The owner must fix Providers and restart.",
            );
        }

        if (first === "browser-profiles" && third === undefined) {
            return browserProfileRoutes(route, second);
        }

        if (first === "provider-packages" && second === undefined) {
            return providerPackageRoutes(route);
        }

        // Subscriptions keep a live client identity for presence and access updates, not a
        // request credential. No await separates authentication from registering that identity.
        if (first === "events" && method === "GET") {
            return events(request, response, url, app.config.userById(user.id)!);
        }

        if (first === "poll" && method === "GET") {
            return poll(request, response, url, app.config.userById(user.id)!);
        }

        if (first === "me" && method === "GET") {
            return json(response, 200, await app.hello(user));
        }

        if (first === "me" && method === "POST") {
            const body = await readJson<{ name?: string }>(request);
            const name = String(body.name ?? "")
                .replace(/\s+/g, " ")
                .trim()
                .slice(0, 40);

            if (name === "") {
                throw new HttpError(400, "Name is empty");
            }

            app.rename(user, name);

            return json(response, 200, { ok: true });
        }

        if (first === "folder-favorites" && second === undefined && method === "GET") {
            return json(response, 200, await app.folderFavorites.list(user));
        }

        if (first === "folder-favorites" && second === undefined && method === "POST") {
            await app.folderFavorites.set(user, await readJson(request));

            return json(response, 200, { ok: true });
        }

        if (first === "logout" && method === "POST") {
            app.sshSessions.revoke(user.id);
            clearAuthCookie(response);

            return json(response, 200, { ok: true });
        }

        if (first === "users" && second === undefined && method === "GET") {
            return json(response, 200, app.people(user));
        }

        if (first === "users" && second !== undefined && third === "remove" && method === "POST") {
            app.removeUser(user, second);

            return json(response, 200, { ok: true });
        }

        if (first === "users" && second !== undefined && third === undefined && method === "POST") {
            const patch = await readJson<Parameters<typeof app.setAccess>[2]>(request);

            app.setAccess(requireUser(request), second, patch);

            return json(response, 200, app.people(user));
        }

        if (first === "visibility" && method === "POST") {
            const body = await readJson<{ tab?: unknown; visible?: unknown }>(request);

            app.setVisible(user, String(body.tab ?? ""), body.visible !== false);

            return json(response, 200, { ok: true });
        }

        // The sessions a connection shows as peek tiles on screen now: they get `peek` events until it sends another list.
        if (first === "peeks" && method === "POST") {
            const body = await readJson<{ connection?: unknown; ids?: unknown; seq?: unknown }>(
                request,
            );

            if (!Array.isArray(body.ids)) {
                throw new HttpError(400, "ids must be a list of session ids");
            }

            if (body.seq !== undefined && !Number.isSafeInteger(body.seq)) {
                throw new HttpError(400, "seq must be a whole number");
            }

            app.setPeeks(
                user,
                String(body.connection ?? ""),
                body.ids.slice(0, MAX_PEEKS).map((id) => conversationId(String(id))),
                body.seq as number | undefined,
            );

            return json(response, 200, { ok: true });
        }

        // Every subagent in the sessions this person can see, as the subagents board shows them.
        if (first === "subagents" && method === "GET") {
            return json(response, 200, app.subagents(user));
        }

        // Named private conversations are separate from the persona-free popup and shared mentions.
        if (first === "pip" && second === "agents" && third === undefined) {
            requireOwner(user);
            response.setHeader("Cache-Control", "no-store");

            if (method === "GET") {
                return json(response, 200, {
                    agents: app.pip.agents.list(user),
                    blueprint: app.pip.agents.blueprint,
                });
            }

            if (method === "POST") {
                return json(
                    response,
                    200,
                    url.searchParams.get("identityOnly") === "1"
                        ? await app.pip.agents.createIdentity(user, await readJson(request))
                        : await app.pip.agents.create(user, await readJson(request)),
                );
            }
        }

        // Identity settings and draft first sends do not require (or create) a home conversation.
        if (first === "pip" && second === "agents" && third !== undefined) {
            requireOwner(user);
            response.setHeader("Cache-Control", "no-store");
            app.pip.agents.ownedIdentity(third, user);

            if (fourth !== "memory" && parts.length > 4) {
                throw new HttpError(404, "No such private agent route");
            }

            if (fourth === undefined && method === "GET") {
                return json(response, 200, await app.pip.agents.read(third, user));
            }

            if (fourth === undefined && method === "POST") {
                return json(
                    response,
                    200,
                    await app.pip.agents.act(third, user, await readJson(request)),
                );
            }

            if (fourth === "memory") {
                const lessonId = parts[4];

                if (parts.length > 6 || (parts[5] !== undefined && parts[5] !== "remove")) {
                    throw new HttpError(404, "No such memory route");
                }

                if (lessonId === undefined && method === "GET") {
                    return json(response, 200, await app.memory.identityView(third, user));
                }

                if (method === "POST") {
                    const body = await readJson<{
                        text?: unknown;
                        scope?: unknown;
                        expectedRevision?: unknown;
                    } | null>(request);

                    if (body === null || typeof body !== "object" || Array.isArray(body)) {
                        throw new HttpError(400, "Expected memory settings");
                    }

                    return json(
                        response,
                        200,
                        lessonId === undefined
                            ? await app.memory.identityRemember(third, user, body)
                            : await app.memory.identityEdit(
                                  third,
                                  user,
                                  lessonId,
                                  parts[5] === "remove" ? "remove" : { text: body.text },
                                  body.expectedRevision,
                              ),
                    );
                }
            }

            if (fourth === "upload" && method === "POST") {
                app.pip.agents.ownedIdentity(third, user, true);
                app.requireSteer(user);
                const attachment = await receiveUpload(
                    request,
                    draftUploadDirectory(app, user, third),
                    url.searchParams.get("name") ?? "upload",
                );

                app.pip.agents.ownedIdentity(third, user, true);

                return json(response, 200, attachment);
            }

            if (fourth === "files" && method === "GET") {
                app.requireSteer(user);
                // First-send conversations use this same native local default folder, not a home Chat.
                const listing = await draftFiles.get(app.defaultCwd);

                app.pip.agents.ownedIdentity(third, user);

                return json(
                    response,
                    200,
                    url.searchParams.get("since") === listing.version
                        ? { version: listing.version, same: true }
                        : {
                              files: listing.files,
                              version: listing.version,
                              truncated: listing.truncated,
                          },
                );
            }

            if (fourth === "configure" && method === "POST") {
                return json(
                    response,
                    200,
                    await app.pip.agents.configureIdentity(third, user, await readJson(request)),
                );
            }

            if (fourth === "submit" && method === "POST") {
                return json(
                    response,
                    200,
                    await app.pip.agents.submitDraft(third, user, await readJson(request)),
                );
            }

            if (fourth === "submit" && method === "GET") {
                const receipt = await app.pip.agents.draftReceipt(
                    third,
                    user,
                    url.searchParams.get("requestId"),
                );

                if (receipt === undefined) {
                    throw new HttpError(404, "No accepted input exists for this request");
                }

                return json(response, 200, receipt);
            }
        }

        // Native PiP settings never load or unload its private tools and recovery tasks.
        if (first === "pip" && second === "settings" && fourth === undefined) {
            requireOwner(user);
            response.setHeader("Cache-Control", "no-store");

            if (method === "POST") {
                const body = await readJson<{
                    enabled?: unknown;
                    compactAt?: unknown;
                } | null>(request);

                if (third === "chats") {
                    await app.pip.configureChats(user, body);
                } else if (third === "collaborator") {
                    app.pip.configureCollaborator(user, body);
                } else if (third === undefined) {
                    if (
                        body === null ||
                        typeof body !== "object" ||
                        Array.isArray(body) ||
                        [body.enabled, body.compactAt].filter((value) => value !== undefined)
                            .length !== 1
                    ) {
                        throw new HttpError(400, "Change one PiP setting at a time.");
                    }

                    if (body.enabled !== undefined) {
                        await app.setPipEnabled(user, body.enabled);
                    } else {
                        await app.setPipCompactAt(user, body.compactAt);
                    }
                } else {
                    throw new HttpError(404, "No such PiP settings route");
                }
            } else if (method !== "GET" || third !== undefined) {
                throw new HttpError(404, "No such PiP settings route");
            }

            return json(response, 200, await app.pip.settings(user));
        }

        // The PiP panel opened or closed in a tab: while open, it gets PiP's conversation (`pipview` events). Opening it
        // the first time makes this person's PiP; the answer says which conversation it is.
        if (first === "pip" && second === undefined && method === "POST") {
            const body = await readJson<{ connection?: unknown; on?: unknown; seq?: unknown }>(
                request,
            );

            if (body.seq !== undefined && !Number.isSafeInteger(body.seq)) {
                throw new HttpError(400, "seq must be a whole number");
            }

            await app.setPip(
                user,
                String(body.connection ?? ""),
                body.on === true,
                body.seq as number | undefined,
            );

            return json(response, 200, { pip: app.pip.state(user) });
        }

        // Webhooks: the ones this person may manage, with the address to give other services; making and removing one.
        if (first === "hooks" && second === undefined && method === "GET") {
            return json(response, 200, await app.commands.hooks(user));
        }

        if (first === "hooks" && second === undefined && method === "POST") {
            return json(response, 200, await app.commands.addHook(user, await readJson(request)));
        }

        // A repository watch removed, by its person or the owner.
        if (
            first === "repo-watches" &&
            second !== undefined &&
            third === "remove" &&
            method === "POST"
        ) {
            await app.repoWatches.remove(user, second);

            return json(response, 200, { ok: true });
        }

        // A repository watch let hear from anyone, or only from the repository's people: by its person or the owner,
        // never by PiP.
        if (
            first === "repo-watches" &&
            second !== undefined &&
            third === "anyone" &&
            method === "POST"
        ) {
            const body = await readJson<{ anyone?: unknown }>(request);

            if (typeof body.anyone !== "boolean") {
                throw new HttpError(400, "anyone must be true or false");
            }

            await app.repoWatches.setAnyone(user, second, body.anyone);

            return json(response, 200, { ok: true });
        }

        // A new secret, for a hook whose address or secret got out.
        if (first === "hooks" && second !== undefined && third === "rotate" && method === "POST") {
            return json(response, 200, await app.hooks.rotate(user, second));
        }

        if (
            first === "hooks" &&
            second !== undefined &&
            parts[2] === "remove" &&
            method === "POST"
        ) {
            await app.commands.removeHook(user, second);

            return json(response, 200, { ok: true });
        }

        // The subagents board opened or closed in a tab: while open, it gets every subagent (`subagents` events).
        if (first === "subagents" && method === "POST") {
            const body = await readJson<{ connection?: unknown; on?: unknown; seq?: unknown }>(
                request,
            );

            if (body.seq !== undefined && !Number.isSafeInteger(body.seq)) {
                throw new HttpError(400, "seq must be a whole number");
            }

            app.setBoard(
                user,
                String(body.connection ?? ""),
                body.on === true,
                body.seq as number | undefined,
            );

            return json(response, 200, { ok: true });
        }

        if (first === "push") {
            return pushRoutes(route, second);
        }

        // Theme folders (`themes.ts`): everyone signed in lists them, as everyone chooses one for their own browsers;
        // only the owner adds, edits, and removes them.
        if (first === "themes" && second === undefined && method === "GET") {
            return json(response, 200, { themes: app.themes.list(user.role === "owner") });
        }

        if (first === "themes" && second === "default" && method === "PUT") {
            await app.setThemeDefault(
                user,
                (await readJson<{ default?: unknown }>(request)).default,
            );

            return json(response, 200, { ok: true });
        }

        if (first === "themes" && second === "duplicate" && method === "POST") {
            requireOwner(user);
            const body = await readJson<{ from?: unknown; name?: unknown; colors?: unknown }>(
                request,
            );

            if (typeof body.from !== "string") {
                throw new HttpError(400, "Say which theme or colors to copy");
            }

            return json(response, 200, {
                id: await app.themes.duplicate(body.from, body.name, body.colors === true),
            });
        }

        if (first === "themes" && second !== undefined && third === "edit" && method === "GET") {
            requireOwner(user);

            return json(response, 200, app.themes.edit(second));
        }

        if (
            first === "themes" &&
            second !== undefined &&
            third === undefined &&
            method === "DELETE"
        ) {
            requireOwner(user);
            app.themes.remove(second);

            return json(response, 200, { ok: true });
        }

        if (first === "running" && method === "GET") {
            return json(response, 200, await runningNow(app, user));
        }

        if (first === "spend" && method === "GET") {
            return json(response, 200, app.spend.summary(user));
        }

        if (first === "spend" && method === "POST") {
            const body = await readJson<{ session?: unknown; person?: unknown; budget?: unknown }>(
                request,
            );

            if (body.session !== undefined) {
                await app.spend.setSessionBudget(
                    user,
                    conversationId(String(body.session)),
                    body.budget,
                );
            } else if (typeof body.person === "string") {
                app.spend.setPersonBudget(user, body.person, body.budget);
            } else {
                throw new HttpError(400, "Say which session or person");
            }

            return json(response, 200, app.spend.summary(user));
        }

        if (first === "private") {
            // Auth and CSRF apply before any socket/process/file access. No private data enters shared room events.
            requireOwner(user);

            if (second === undefined && method === "GET") {
                return json(response, 200, await app.privateSessions.list(user));
            }

            if (second !== undefined && third === undefined && method === "GET") {
                return json(response, 200, await app.privateSessions.pane(user, second));
            }

            if (second !== undefined && third === "upload" && fourth === undefined) {
                if (method === "POST") {
                    return json(
                        response,
                        200,
                        await app.privateSessions.upload(
                            user,
                            second,
                            url.searchParams.get("revision"),
                            url.searchParams.get("name"),
                            request,
                        ),
                    );
                }

                if (method === "DELETE") {
                    return json(
                        response,
                        200,
                        await app.privateSessions.deleteUpload(
                            user,
                            second,
                            url.searchParams.get("id"),
                        ),
                    );
                }
            }

            if (second !== undefined && fourth === undefined && method === "POST") {
                if (third === "terminal") {
                    return json(
                        response,
                        200,
                        await app.privateTerminals.ticket(request, second, await readJson(request)),
                    );
                }

                if (third === "prompt") {
                    return json(
                        response,
                        200,
                        await app.privateSessions.prompt(
                            user,
                            second,
                            await readJson<PrivateRequest>(request),
                        ),
                    );
                }

                if (third === "import-preview") {
                    return json(
                        response,
                        200,
                        await app.privateSessions.importPreview(
                            user,
                            second,
                            await readJson<PrivateRequest>(request),
                        ),
                    );
                }
            }

            throw new HttpError(404, "No such private session action");
        }

        if (
            first === "pi-sessions" &&
            second === "history" &&
            third === undefined &&
            method === "GET"
        ) {
            response.setHeader("cache-control", "no-store");

            return json(response, 200, await app.piSessions.history(user));
        }

        if (first === "pi-sessions" && second === "active") {
            response.setHeader("cache-control", "no-store");

            if (third === undefined && method === "GET") {
                return json(response, 200, await app.piSessions.active.list(user));
            }

            if (third === "preview" && method === "POST") {
                return json(
                    response,
                    200,
                    await app.piSessions.active.preview(user, await readJson(request)),
                );
            }

            if (third === undefined && method === "POST") {
                return json(
                    response,
                    200,
                    await app.piSessions.active.move(user, await readJson(request)),
                );
            }
        }

        if (first === "pi-sessions" && second === "preview" && method === "POST") {
            response.setHeader("cache-control", "no-store");

            return json(
                response,
                200,
                await app.piSessions.preview(user, await readJson<ImportRequest>(request)),
            );
        }

        if (
            first === "pi-sessions" &&
            (second === undefined || second === "continue") &&
            method === "POST"
        ) {
            return json(
                response,
                200,
                await app.piSessions.create(user, await readJson<ImportRequest>(request)),
            );
        }

        if (
            first === "pi-sessions" &&
            second !== undefined &&
            third === "archive" &&
            method === "GET"
        ) {
            const archive = await app.piSessions.archive(user, conversationId(second));

            response.writeHead(200, {
                "content-type": "application/x-ndjson; charset=utf-8",
                "content-disposition": 'attachment; filename="original-pi-session.jsonl"',
                "cache-control": "no-store",
            });
            response.end(archive);

            return;
        }

        if (first === "projects" && second === undefined && method === "GET") {
            return json(response, 200, app.projects.list(user));
        }

        if (first === "projects" && second === undefined && method === "POST") {
            const body = await readJson<{ name?: unknown; cwd?: unknown; requestId?: unknown }>(
                request,
            );

            return json(response, 200, await app.projects.create(user, body));
        }

        if (
            first === "projects" &&
            second !== undefined &&
            third === undefined &&
            method === "POST"
        ) {
            const body = await readJson<{ name?: unknown; cwd?: unknown }>(request);

            await app.projects.update(user, second, body);

            return json(response, 200, { ok: true });
        }

        if (first === "sessions" && second === undefined && method === "GET") {
            return json(response, 200, app.sessions(user));
        }

        // All local Pi discovery remains behind the explicit continuation permission.
        if (first === "pi-sessions" && second === undefined && method === "GET") {
            response.setHeader("cache-control", "no-store");

            return json(
                response,
                200,
                await app.piSessions.list(user, url.searchParams.get("q") ?? ""),
            );
        }

        if (first === "pi-sessions" && second === "preview" && method === "GET") {
            response.setHeader("cache-control", "no-store");

            return json(
                response,
                200,
                await app.piSessions.preview(user, { path: url.searchParams.get("path") ?? "" }),
            );
        }

        if (first === "sessions" && second === undefined && method === "POST") {
            const body = await readJson<CreateSessionRequest>(request);

            return json(response, 200, await app.commands.createSession(user, body));
        }

        if (first === "sessions" && second !== undefined && method === "POST") {
            const body = await readJson<SessionPatch>(request);

            await app.commands.updateSession(conversationId(second), user, body);

            return json(response, 200, { ok: true });
        }

        if (first === "c" && second !== undefined) {
            const id = conversationId(second);

            app.requireSee(user, id);
            // Serialize existence with creation, then recheck access: a guessed future ID must not
            // slip into PiP's internal lane while its first admission is still committing.
            await app.conversation(id);
            app.requireSee(user, id);

            if (third === "browser") {
                return browserRoutes(route, id, fourth, options.listen.port);
            }

            return conversationRoutes(route, id, parts);
        }

        if (first === "approvals" && second !== undefined && method === "POST") {
            const body = await readJson<{ allow?: boolean }>(request);

            // An id may hold a slash, which the path decoded into a part of its own: a codemode script's calls are
            // named `<call>/<n>`.
            if (!(await app.answerApproval(parts.slice(1).join("/"), body.allow === true, user))) {
                throw new HttpError(404, "That approval is no longer pending");
            }

            return json(response, 200, { ok: true });
        }

        if (first === "ssh-auth" && second === undefined) {
            requireOwner(user);
            response.setHeader("cache-control", "no-store");

            if (method === "GET") {
                const location = parseWorkspaceLocation({
                    kind: "ssh",
                    host: url.searchParams.get("host"),
                });

                return json(response, 200, app.sshSessions.status(user, location!.host));
            }

            if (method === "POST") {
                const body = await readJson<{
                    host?: unknown;
                    password?: unknown;
                    forget?: unknown;
                }>(request, 8192);
                const current = requireUser(request);

                requireOwner(current);
                const location = parseWorkspaceLocation({ kind: "ssh", host: body.host })!;

                if (body.forget === true) {
                    app.sshSessions.forget(current, location.host);

                    return json(response, 200, { authenticated: false });
                }

                const here = new URL(origin(request));
                const loopback = /^(localhost|127\.\d+\.\d+\.\d+|\[::1\])$/.test(here.hostname);

                if (here.protocol !== "https:" && !loopback) {
                    throw new HttpError(
                        403,
                        "Password login needs HTTPS or localhost. Open Coop through a secure address.",
                    );
                }

                if (
                    typeof body.password !== "string" ||
                    !body.password ||
                    Buffer.byteLength(body.password) > 1024 ||
                    /[\r\n\0]/.test(body.password)
                ) {
                    throw new HttpError(
                        400,
                        "Enter an SSH password without line breaks or NUL characters, at most 1024 UTF-8 bytes.",
                    );
                }

                const tokenHash = current.tokenHash;
                const cancelled = withCancel(BACKGROUND_CONTEXT);
                const cancel = () => cancelled.cancel();
                const timer = setTimeout(cancel, 60_000);

                timer.unref();
                request.once("aborted", cancel);
                response.once("close", cancel);

                try {
                    const login = app.sshSessions.login(
                        current,
                        location.host,
                        body.password,
                        cancelled.context,
                        () => {
                            const fresh = auth.user(request);

                            return (
                                fresh?.id === current.id &&
                                fresh.role === "owner" &&
                                fresh.tokenHash === tokenHash
                            );
                        },
                    );

                    delete body.password;

                    return json(response, 200, await login);
                } finally {
                    delete body.password;
                    clearTimeout(timer);
                    cancelled.cancel();
                    request.off("aborted", cancel);
                    response.off("close", cancel);
                }
            }

            throw new HttpError(405, "Use GET or POST for SSH login.");
        }

        if (first === "ssh-hosts" && second === undefined && method === "GET") {
            requireOwner(user);
            response.setHeader("cache-control", "no-store");
            const discovered = await app.sshSessions.hosts(user);

            // Configuration scanning can await filesystem I/O; do not return private aliases after revocation.
            requireOwner(requireUser(request));

            return json(response, 200, discovered);
        }

        if (first === "fs" && method === "GET") {
            requireOwner(user);

            if (user.sessions !== undefined) {
                throw new HttpError(403, "You were invited to one session.");
            }

            const requested = url.searchParams.get("path") || "~";
            const host = url.searchParams.get("host");
            const location = parseWorkspaceLocation(
                host === null ? undefined : { kind: "ssh", host },
            );

            if (location !== undefined) {
                const listing = await withReadContext({ request, response }, (context) =>
                    app.sshSessions.browse(
                        user,
                        location.host,
                        requested,
                        url.searchParams.get("hidden") === "1",
                        context,
                    ),
                );

                return json(response, 200, listing);
            }

            const path = app.workspace.checkDirectory(requested);
            const showHidden = url.searchParams.get("hidden") === "1";
            const dirs: { name: string; path: string }[] = [];

            for (const entry of readdirSync(path, { withFileTypes: true })) {
                if (!showHidden && entry.name.startsWith(".")) {
                    continue;
                }

                let isDir = entry.isDirectory();

                if (entry.isSymbolicLink()) {
                    try {
                        isDir = statSync(join(path, entry.name)).isDirectory();
                    } catch {
                        isDir = false;
                    }
                }

                if (isDir) {
                    dirs.push({ name: entry.name, path: join(path, entry.name) });
                }
            }

            dirs.sort((a, b) => a.name.localeCompare(b.name));
            const recent = [
                ...new Set(
                    app
                        .sessions(user)
                        .filter(
                            (session) =>
                                app.locationOf(conversationId(String(session.id))) === undefined,
                        )
                        .map((session) => session.cwd),
                ),
            ].slice(0, 8);

            return json(response, 200, {
                path,
                parent: dirname(path) === path ? null : dirname(path),
                home: homedir(),
                dirs: dirs.slice(0, 1000),
                recent,
            });
        }

        // A new folder, from the folder picker: it opens in the picker, ready to use.
        if (first === "fs" && second === undefined && method === "POST") {
            const body = await readJson<{ path?: unknown; location?: unknown }>(request);
            const current = requireUser(request);

            requireOwner(current);
            const location = parseWorkspaceLocation(body.location);

            if (typeof body.path !== "string") {
                throw new HttpError(400, "Name the folder to make.");
            }

            if (location !== undefined) {
                const made = await app.sshSessions.createDirectory(
                    current,
                    location.host,
                    body.path,
                    BACKGROUND_CONTEXT,
                );

                return json(response, 200, made);
            }

            return json(response, 200, { path: app.workspace.makeFolder(current, body.path) });
        }

        if (first === "agents" && third === undefined) {
            requireOwner(user);
            const prompts = app.config.agentPrompts;
            const roles = app.workItems.profiles().map(({ id, name, description, prompt }) => ({
                type: id,
                name,
                description,
                defaultPrompt: prompt,
            }));
            const agent = roles.find((each) => each.type === second);
            const settings = (role: (typeof roles)[number]) => ({
                ...role,
                prompt: prompts[role.type] ?? role.defaultPrompt,
            });

            response.setHeader("Cache-Control", "no-store");

            if (second === undefined && method === "GET") {
                return json(response, 200, {
                    agents: roles.map(settings),
                    workItemsEnabled: app.workItems.enabled,
                    maxPromptLength: MAX_AGENT_PROMPT_LENGTH,
                });
            }

            if (second === undefined && method === "POST") {
                const body = await readJson<{ workItemsEnabled?: unknown } | null>(request);

                await app.setWorkItemsEnabled(user, body?.workItemsEnabled);

                return json(response, 200, { workItemsEnabled: app.workItems.enabled });
            }

            if (agent !== undefined && method === "POST") {
                const body = await readJson<{ prompt?: unknown; expectedPrompt?: unknown } | null>(
                    request,
                );

                if (
                    body === null ||
                    typeof body.prompt !== "string" ||
                    body.prompt.trim() === "" ||
                    body.prompt.length > MAX_AGENT_PROMPT_LENGTH
                ) {
                    throw new HttpError(
                        400,
                        `Use a non-empty system prompt of at most ${MAX_AGENT_PROMPT_LENGTH} characters.`,
                    );
                }

                // Re-read after the body arrives: another owner's tab may have saved meanwhile.
                const current = app.config.agentPrompts;

                if (body.expectedPrompt !== (current[agent.type] ?? agent.defaultPrompt)) {
                    throw new HttpError(
                        409,
                        "This agent's prompt changed elsewhere. Reopen Settings to load it; keep a copy of your draft first.",
                    );
                }

                if (app.workItems.profile(agent.type)?.prompt !== agent.defaultPrompt) {
                    throw new HttpError(
                        409,
                        "This agent profile changed or became unavailable; reopen Settings",
                    );
                }

                if (body.prompt === agent.defaultPrompt) {
                    delete current[agent.type];
                } else {
                    current[agent.type] = body.prompt;
                }

                app.config.agentPrompts = current;

                return json(response, 200, {
                    ...agent,
                    prompt: body.prompt,
                    defaultPrompt: agent.defaultPrompt,
                });
            }

            throw new HttpError(404, "No such agent settings route");
        }

        if (first === "settings" && method === "POST") {
            const body = await readJson<{
                approvalRule?: unknown;
                defaultModel?: unknown;
                pipCompactAt?: unknown;
                subagentModels?: unknown;
            }>(request);

            // One at a time: a second that fails must not leave the first changed.
            if (
                [
                    body.approvalRule,
                    body.defaultModel,
                    body.pipCompactAt,
                    body.subagentModels,
                ].filter((value) => value !== undefined).length > 1
            ) {
                throw new HttpError(400, "Change one setting at a time.");
            }

            // The models subagents may run on besides their session's own: the owner's (checked in `app.ts`).
            if (body.subagentModels !== undefined) {
                await app.setSubagentModels(user, body.subagentModels);
            }

            if (body.pipCompactAt !== undefined) {
                await app.setPipCompactAt(user, body.pipCompactAt);
            }

            if (body.approvalRule !== undefined) {
                await app.setApprovalRule(user, body.approvalRule);
            }

            // Null clears it: new sessions start with the last model picked again.
            if (body.defaultModel !== undefined) {
                await app.setDefaultModel(user, body.defaultModel);
            }

            return json(response, 200, { ok: true });
        }

        // One model allowed for subagents, or no longer: the rest stay as they are. The owner's (checked in `app.ts`).
        if (first === "subagent-models" && second === undefined && method === "POST") {
            const body = await readJson<{ model?: unknown; allowed?: unknown }>(request);

            return json(response, 200, {
                subagentModels: await app.allowSubagentModel(user, body.model, body.allowed),
            });
        }

        // Routes extension modules add, each checking who may use it (`extension-routes.ts`).
        if (first === "x" && second !== undefined) {
            return extensionRoute(route, parts.slice(1));
        }

        if (first === "extensions" && second === undefined && method === "GET") {
            return json(response, 200, await app.extensions(user));
        }

        if (
            first === "extensions" &&
            second !== undefined &&
            third === undefined &&
            method === "POST"
        ) {
            requireOwner(user);
            const body = await readJson<{ enabled?: unknown }>(request);

            if (typeof body.enabled !== "boolean") {
                throw new HttpError(400, "enabled must be true or false");
            }

            await app.setExtensionEnabled(user, second, body.enabled);

            return json(response, 200, await app.extensions(user));
        }

        if (
            first === "extensions" &&
            second !== undefined &&
            third === "reload" &&
            method === "POST"
        ) {
            requireOwner(user);
            await app.reloadExtension(second);

            return json(response, 200, await app.extensions(user));
        }

        if (
            first === "models" &&
            second === "refresh" &&
            third === undefined &&
            method === "POST"
        ) {
            requireOwner(user);

            return json(response, 200, await app.providers.modelRefresh.refresh());
        }

        // For the owner, each subscription's sign-in is asked afresh first (three seconds at most; a mark found later
        // comes with the models): one that can no longer be renewed shows as needing sign-in. Others see what was last
        // found, so nobody else makes the server ask providers.
        if (first === "providers" && second === undefined && method === "GET") {
            if (user.role === "owner") {
                await app.providers.checkAll(3_000);
            }

            return json(response, 200, app.providers.list(user.role === "owner"));
        }

        if (
            first === "providers" &&
            second !== undefined &&
            third === "login" &&
            method === "POST"
        ) {
            requireOwner(user);
            const body = await readJson<{ type?: string }>(request);

            return json(response, 200, {
                flowId: app.providers.startLogin(
                    user,
                    second,
                    body.type === "oauth" ? "oauth" : "api_key",
                ),
            });
        }

        if (
            first === "providers" &&
            second !== undefined &&
            third === "logout" &&
            method === "POST"
        ) {
            requireOwner(user);
            await app.providers.logout(second);

            return json(response, 200, { ok: true });
        }

        if (
            first === "providers" &&
            second !== undefined &&
            third === "refresh" &&
            fourth === undefined &&
            method === "POST"
        ) {
            requireOwner(user);

            try {
                await app.providers.refresh(second);
            } catch (error) {
                if (error instanceof HttpError) {
                    throw error;
                }

                throw new HttpError(
                    409,
                    "Hosted model refresh failed. Try again when the provider is idle.",
                );
            }

            return json(response, 200, { ok: true });
        }

        if (first === "auth" && second !== undefined && third === "cancel" && method === "POST") {
            app.providers.cancelLogin(user, second);

            return json(response, 200, { ok: true });
        }

        if (first === "auth" && second !== undefined && third !== undefined && method === "POST") {
            const body = await readJson<{ value?: string; cancel?: boolean }>(request);

            app.providers.answerLogin(
                user,
                second,
                third,
                body.cancel === true ? undefined : String(body.value ?? ""),
            );

            return json(response, 200, { ok: true });
        }

        if (first === "invite" && second === "cancel" && method === "POST") {
            const body = (await readJson(request)) as { code?: unknown };

            if (typeof body.code !== "string") {
                throw new HttpError(400, "Say which invite.");
            }

            // Only whoever made it ends it; for anyone else it stays as it was, and nothing says whether it exists.
            auth.cancelInvite(body.code, requireUser(request));

            return json(response, 200, { ok: true });
        }

        if (first === "invite" && second === undefined && method === "POST") {
            const body = (await readJson(request)) as {
                role?: unknown;
                session?: unknown;
                continuePiSessions?: unknown;
                projectAccess?: unknown;
                minutes?: unknown;
            };
            const creator = requireUser(request);
            const grant = inviteGrant(creator, body);
            const invite = auth.createInvite(creator, grant, inviteMinutes(body));
            const here = origin(request);
            const loopback = /^https?:\/\/(localhost|127\.\d+\.\d+\.\d+|\[::1\])(:\d+)?$/.test(
                here,
            );
            const wildcard = options.listen.host === "0.0.0.0" || options.listen.host === "::";
            const lan =
                loopback && wildcard
                    ? lanAddresses().map((address) => `http://${address}:${options.listen.port}`)
                    : [];
            // A tunnel the launcher started is the way in for other devices.
            const tunnel = loopback ? app.access?.url : undefined;
            const base = tunnel ?? lan[0] ?? here;
            const link = `${base}/join/${invite.code}`;
            // An invite whose QR code could not be made is never shown: it ends rather than stay live, unseen.
            const svg = await QRCode.toString(link, {
                type: "svg",
                margin: 1,
                color: { dark: "#000000", light: "#ffffff" },
            }).catch((error: unknown) => {
                auth.cancelInvite(invite.code, user);

                throw error;
            });

            return json(response, 200, {
                ...invite,
                grant,
                url: link,
                svg,
                alternatives: (tunnel === undefined ? lan.slice(1) : lan).map(
                    (address) => `${address}/join/${invite.code}`,
                ),
                // Only this device can open a loopback link.
                local: loopback && lan.length === 0 && tunnel === undefined,
                ...(app.access === undefined ? {} : { access: app.access }),
            });
        }

        if (first === "restart" && method === "POST") {
            requireOwner(user);

            if (!app.supervised) {
                throw new HttpError(
                    409,
                    "Start Pi Coop with bin/pi-coop.js to restart from the app.",
                );
            }

            json(response, 200, { ok: true });
            setTimeout(() => options.restart(), 100);

            return;
        }

        throw new HttpError(404, "Unknown API route");
    };
}
