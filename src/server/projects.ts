/** Durable project membership, independent of working folders, thread type and access. */
import { createHash, randomUUID } from "node:crypto";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import type { ConversationId, Tx } from "@earendil-works/pi-durable";
import type { PocketApp } from "./app.ts";
import type { User } from "./config.ts";
import {
    type Project,
    type Projects as ProjectsData,
    ProjectsDoc,
    type SessionMeta,
    SessionsDoc,
} from "./docs.ts";
import { HttpError } from "./errors.ts";
import type { ThreadType } from "./workflow-docs.ts";
import { parseWorkspaceLocation, type WorkspaceLocation } from "./workspace-location.ts";
import { projectGranted } from "./project-access.ts";

const context = BACKGROUND_CONTEXT;
const MAX_NAME = 160;
const MAX_REQUESTS = 10_000;

export type ProjectSelection = {
    projectId?: string;
    threadType: ThreadType;
    cwd?: string;
    location?: WorkspaceLocation;
};

export type ProjectPlacement = { projectId?: string; threadType: ThreadType };
export type SelectProject = {
    projectId?: unknown;
    threadType?: unknown;
};
export type CreateProject = {
    name?: unknown;
    cwd?: unknown;
    location?: unknown;
    defaultAgentId?: unknown;
    requestId?: unknown;
};
export type UpdateProject = {
    name?: unknown;
    cwd?: unknown;
    location?: unknown;
    defaultAgentId?: unknown;
};
export type AssignProject = { projectId?: unknown };

function empty(): ProjectsData {
    return { projects: {}, requests: {} };
}

function text(value: unknown, label: string, limit: number): string {
    if (
        typeof value !== "string" ||
        value.trim() === "" ||
        value.length > limit ||
        value.includes("\0")
    ) {
        throw new HttpError(400, `${label} must be 1–${limit} characters without NUL`);
    }

    return value.trim();
}

/** Null or an empty selector clears membership; omitted fields can retain it on assignment. */
function optionalId(value: unknown, label: string): string | undefined {
    if (value === undefined || value === null || value === "") {
        return undefined;
    }

    return text(value, label, 160);
}

function digest(value: unknown): string {
    return createHash("sha256").update(JSON.stringify(value)).digest("hex");
}

function project(doc: ProjectsData, id: string): Project & { cwd: string } {
    if (!Object.hasOwn(doc.projects, id)) {
        throw new HttpError(404, "No such project");
    }

    return doc.projects[id]!;
}

function selection(
    doc: ProjectsData,
    request: SelectProject,
    defaultStarter?: string,
): ProjectSelection {
    const projectId = optionalId(request.projectId, "projectId");
    const selectedProject = projectId === undefined ? undefined : project(doc, projectId);
    const threadType =
        request.threadType === undefined
            ? projectId === undefined
                ? "chat"
                : defaultStarter
            : request.threadType;

    if (typeof threadType !== "string" || !threadType) {
        throw new HttpError(
            400,
            "Select an available starter profile or enable a workflow extension",
        );
    }

    return {
        ...(projectId === undefined ? {} : { projectId }),
        threadType,
        ...(selectedProject === undefined
            ? {}
            : {
                  cwd: selectedProject.cwd,
                  ...(selectedProject.location === undefined
                      ? {}
                      : { location: selectedProject.location }),
              }),
    };
}

export class Projects {
    readonly #app: PocketApp;
    #doc: ProjectsData = empty();
    /** Only server-prepared selections can start sessions, with their authenticated creator. */
    readonly #prepared = new WeakMap<ProjectSelection, string>();

    constructor(app: PocketApp) {
        this.#app = app;
    }

    async recover(): Promise<void> {
        this.committed(await this.#app.harness.snapshot(ProjectsDoc, context));
    }

    /** The commit coordinator supplies the already adopted document; no Session API calls here. */
    committed(value: unknown): void {
        this.#doc = (value as ProjectsData | undefined) ?? empty();
    }

    #person(supplied: User): User {
        const user = this.#app.config.userById(supplied.id);

        if (user === undefined || user.tokenHash !== supplied.tokenHash) {
            throw new HttpError(401, "Your access was removed");
        }

        return user;
    }

    #editor(supplied: User): User {
        const user = this.#person(supplied);

        this.#app.requireSteer(user);

        if (user.role !== "owner") {
            throw new HttpError(403, "Only the owner can manage projects and their destinations");
        }

        return user;
    }

    #defaultAgent(user: User, id: string | undefined): void {
        if (id !== undefined) {
            this.#app.pip.agents.ownedIdentity(id, user);
        }
    }

    canAccess(supplied: User, id: string): boolean {
        const user = this.#app.config.userById(supplied.id);
        const item = Object.hasOwn(this.#doc.projects, id) ? this.#doc.projects[id] : undefined;

        return (
            user !== undefined &&
            user.tokenHash === supplied.tokenHash &&
            item !== undefined &&
            user.sessions === undefined &&
            projectGranted(user, item)
        );
    }

    /** Machine/local selectors never expose an old thread pinned to a different namespace. */
    canAccessThread(user: User, meta: SessionMeta): boolean {
        if (meta.projectId === undefined || !this.canAccess(user, meta.projectId)) {
            return false;
        }

        const current = this.#app.config.userById(user.id)!;

        return projectGranted(current, { id: meta.projectId, location: meta.location });
    }

    #creator(supplied: User, selected: ProjectSelection): User {
        const user = this.#person(supplied);

        this.#app.requireSteer(user);

        if (
            user.sessions !== undefined ||
            (user.role !== "owner" &&
                (selected.projectId === undefined || !this.canAccess(user, selected.projectId)))
        ) {
            throw new HttpError(403, "Choose a project the owner has shared with you");
        }

        return user;
    }

    list(supplied: User): { projects: Project[] } {
        const user = this.#person(supplied);
        const scoped = user.sessions !== undefined;
        const projectIds = new Set(
            this.#app
                .sessions(user)
                .flatMap((item) => (item.projectId === undefined ? [] : [item.projectId])),
        );
        const projects = Object.values(this.#doc.projects)
            .filter((item) => (scoped ? projectIds.has(item.id) : this.canAccess(user, item.id)))
            .map((item): Project => {
                const copy: Project = { ...item };

                if (scoped) {
                    delete copy.cwd;
                    delete copy.location;
                }

                if (user.role !== "owner" || scoped) {
                    delete copy.defaultAgentId;
                } else if (copy.defaultAgentId !== undefined) {
                    try {
                        this.#defaultAgent(user, copy.defaultAgentId);
                    } catch (error) {
                        if (!(error instanceof HttpError) || error.status !== 404) {
                            throw error;
                        }

                        delete copy.defaultAgentId;
                    }
                }

                return copy;
            });

        return { projects };
    }

    async create(supplied: User, request: CreateProject): Promise<{ id: string }> {
        supplied = { ...supplied };
        const user = this.#editor(supplied);
        const name = text(request.name, "name", MAX_NAME);
        const askedCwd = text(request.cwd, "cwd", 4096);
        const key = digest([user.id, text(request.requestId, "requestId", 160)]);
        const location = parseWorkspaceLocation(request.location);
        const defaultAgentId = optionalId(request.defaultAgentId, "defaultAgentId");
        const fingerprint = digest([
            name,
            askedCwd,
            ...(location === undefined ? [] : [location]),
            ...(defaultAgentId === undefined ? [] : [defaultAgentId]),
        ]);
        const previous = this.#doc.requests[key];

        // A committed retry needs no SSH connection. The transaction below still arbitrates
        // concurrent first attempts after preparation, without holding the global mutation line.
        if (previous !== undefined) {
            if (previous.fingerprint !== fingerprint) {
                throw new HttpError(409, "This requestId was already used for another project");
            }

            return { id: previous.id };
        }

        this.#defaultAgent(user, defaultAgentId);
        const cwd =
            location === undefined
                ? this.#app.workspace.checkDirectory(askedCwd)
                : await this.#app.sshSessions.prepare(user, { cwd: askedCwd, location }, context);

        return this.#app.harness.commit(async (tx) => {
            const doc = await tx.doc(ProjectsDoc);
            const current = this.#editor(supplied);

            if (Object.hasOwn(doc.requests, key)) {
                const receipt = doc.requests[key]!;

                if (receipt.fingerprint !== fingerprint) {
                    throw new HttpError(409, "This requestId was already used for another project");
                }

                return { id: receipt.id };
            }

            if (Object.keys(doc.requests).length >= MAX_REQUESTS) {
                throw new HttpError(413, "The project creation request limit has been reached");
            }

            this.#defaultAgent(current, defaultAgentId);
            const id = `p-${randomUUID()}`;
            const now = Date.now();

            doc.projects[id] = {
                id,
                name,
                cwd,
                ...(location === undefined ? {} : { location }),
                ...(defaultAgentId === undefined ? {} : { defaultAgentId }),
                createdAt: now,
                updatedAt: now,
                createdBy: current.id,
            };
            doc.requests[key] = { id, fingerprint };

            return { id };
        }, context);
    }

    async update(supplied: User, id: string, request: UpdateProject): Promise<void> {
        supplied = { ...supplied };
        const user = this.#editor(supplied);
        const name = request.name === undefined ? undefined : text(request.name, "name", MAX_NAME);
        const defaultAgentId = optionalId(request.defaultAgentId, "defaultAgentId");

        this.#defaultAgent(user, defaultAgentId);
        const askedCwd = request.cwd === undefined ? undefined : text(request.cwd, "cwd", 4096);
        const original = project(this.#doc, id);
        const originalCwd = original.cwd;
        const originalLocation = JSON.stringify(original.location);
        const location =
            request.location === undefined
                ? original.location
                : parseWorkspaceLocation(request.location);
        const changedLocation = request.location !== undefined;
        const path = askedCwd ?? (changedLocation ? originalCwd : undefined);
        const cwd =
            path === undefined
                ? undefined
                : location === undefined
                  ? this.#app.workspace.checkDirectory(path)
                  : await this.#app.sshSessions.prepare(user, { cwd: path, location }, context);

        await this.#app.harness.commit(async (tx) => {
            const doc = await tx.doc(ProjectsDoc);

            const current = this.#editor(supplied);

            this.#defaultAgent(current, defaultAgentId);
            const item = project(doc, id);

            if (
                path !== undefined &&
                (item.cwd !== originalCwd || JSON.stringify(item.location) !== originalLocation)
            ) {
                throw new HttpError(409, "The project folder changed. Reload before editing it.");
            }

            if (changedLocation) {
                if (location === undefined) {
                    delete item.location;
                } else {
                    item.location = location;
                }
            }

            if (name !== undefined) {
                item.name = name;
            }

            if (cwd !== undefined) {
                item.cwd = cwd;
            }

            if (request.defaultAgentId !== undefined) {
                if (defaultAgentId === undefined) {
                    delete item.defaultAgentId;
                } else {
                    item.defaultAgentId = defaultAgentId;
                }
            }

            if (name !== undefined || cwd !== undefined || request.defaultAgentId !== undefined) {
                item.updatedAt = Date.now();
            }
        }, context);
    }

    /** Validate before worktree creation without creating a conversation. */
    prepare(supplied: User, request: SelectProject): ProjectSelection {
        const prepared = Object.freeze(
            selection(this.#doc, request, this.#app.workItems.defaultStarter()),
        );
        const user = this.#creator(supplied, prepared);

        this.#requireStarter(prepared.threadType);
        this.#prepared.set(prepared, user.id);

        return prepared;
    }

    #requireStarter(type: string): void {
        if (this.#app.workItems.profile(type)?.starter !== true) {
            throw new HttpError(
                400,
                "Choose an available starter profile; other profiles require a human handoff",
            );
        }
    }

    /** Safe in conversation init: only document reads, including after the conversation's table writes. */
    async place(tx: Tx, prepared: ProjectSelection): Promise<ProjectPlacement> {
        const userId = this.#prepared.get(prepared);

        if (userId === undefined) {
            throw new HttpError(400, "Prepare the project selection before starting a session");
        }

        const doc = await tx.doc(ProjectsDoc);
        const user = this.#app.config.userById(userId);

        if (user === undefined) {
            throw new HttpError(401, "Your access was removed");
        }

        const current = selection(doc, prepared);

        this.#creator(user, current);

        this.#requireStarter(current.threadType);

        if (
            current.cwd !== prepared.cwd ||
            JSON.stringify(current.location) !== JSON.stringify(prepared.location)
        ) {
            throw new HttpError(409, "The project folder changed; try starting the session again");
        }

        return {
            ...(current.projectId === undefined ? {} : { projectId: current.projectId }),
            threadType: current.threadType,
        };
    }

    async assign(supplied: User, id: ConversationId, request: AssignProject): Promise<void> {
        const user = this.#editor(supplied);

        this.#app.requireSee(user, id);

        if (Object.hasOwn(request, "threadType")) {
            throw new HttpError(400, "Moving a thread cannot change its type");
        }

        await this.#app.requireDriver(id, user);
        await this.#app.harness.commit((tx) => this.assignTx(tx, supplied, id, request), context);
    }

    /** Group placement and combined group updates share one transaction. */
    async assignTx(
        tx: Tx,
        supplied: User,
        id: ConversationId,
        request: AssignProject,
    ): Promise<void> {
        const doc = await tx.doc(ProjectsDoc);
        const sessions = await tx.doc(SessionsDoc);
        const current = this.#editor(supplied);
        const meta = sessions.items[String(id)];

        if (meta === undefined) {
            throw new HttpError(404, "No such session");
        }

        const projectId =
            request.projectId === undefined
                ? undefined
                : (selection(doc, {
                      projectId: optionalId(request.projectId, "projectId") ?? null,
                      threadType: meta.threadType ?? "worker",
                  }).projectId ?? null);

        await this.#app.workItems.assignProject(tx, id, current, projectId);
    }
}
