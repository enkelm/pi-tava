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
    TurnsDoc,
} from "./docs.ts";
import { HttpError } from "./errors.ts";
import { HandoffsDoc, type ThreadType } from "./workflow-docs.ts";

const context = BACKGROUND_CONTEXT;
const MAX_NAME = 160;
const MAX_REQUESTS = 10_000;

export type ProjectSelection = {
    projectId?: string;
    threadType: ThreadType;
    cwd?: string;
};

export type ProjectPlacement = { projectId?: string; threadType: ThreadType };
export type SelectProject = {
    projectId?: unknown;
    threadType?: unknown;
};
export type CreateProject = { name?: unknown; cwd?: unknown; requestId?: unknown };
export type UpdateProject = { name?: unknown; cwd?: unknown };
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
        ...(selectedProject === undefined ? {} : { cwd: selectedProject.cwd }),
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

        if (user === undefined) {
            throw new HttpError(401, "Your access was removed");
        }

        return user;
    }

    #editor(supplied: User): User {
        const user = this.#person(supplied);

        this.#app.requireSteer(user);

        if (user.sessions !== undefined) {
            throw new HttpError(
                403,
                "You were invited to particular sessions and cannot edit projects",
            );
        }

        return user;
    }

    #see(user: User, id: ConversationId, meta: SessionMeta): void {
        this.#app.requireSee(user, id);

        // Also enforce this transaction's catalogue rather than trusting an earlier cached flag.
        if (meta.ownerOnly === true && user.role !== "owner") {
            throw new HttpError(404, "This session is not shared with you.");
        }
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
            .filter((item) => !scoped || projectIds.has(item.id))
            .map((item): Project => {
                const copy: Project = { ...item };

                if (scoped) {
                    delete copy.cwd;
                }

                return copy;
            });

        return { projects };
    }

    async create(supplied: User, request: CreateProject): Promise<{ id: string }> {
        const user = this.#editor(supplied);
        const name = text(request.name, "name", MAX_NAME);
        const askedCwd = text(request.cwd, "cwd", 4096);
        const key = digest([user.id, text(request.requestId, "requestId", 160)]);
        const fingerprint = digest([name, askedCwd]);

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

            const cwd = this.#app.workspace.checkDirectory(askedCwd);
            const id = `p-${randomUUID()}`;
            const now = Date.now();

            doc.projects[id] = {
                id,
                name,
                cwd,
                createdAt: now,
                updatedAt: now,
                createdBy: current.id,
            };
            doc.requests[key] = { id, fingerprint };

            return { id };
        }, context);
    }

    async update(supplied: User, id: string, request: UpdateProject): Promise<void> {
        this.#editor(supplied);
        const name = request.name === undefined ? undefined : text(request.name, "name", MAX_NAME);
        const askedCwd = request.cwd === undefined ? undefined : text(request.cwd, "cwd", 4096);

        await this.#app.harness.commit(async (tx) => {
            const doc = await tx.doc(ProjectsDoc);

            this.#editor(supplied);
            const item = project(doc, id);
            const cwd =
                askedCwd === undefined ? undefined : this.#app.workspace.checkDirectory(askedCwd);

            if (name !== undefined) {
                item.name = name;
            }

            if (cwd !== undefined) {
                item.cwd = cwd;
            }

            if (name !== undefined || cwd !== undefined) {
                item.updatedAt = Date.now();
            }
        }, context);
    }

    /** Validate before worktree creation without creating a conversation. */
    prepare(supplied: User, request: SelectProject): ProjectSelection {
        const user = this.#editor(supplied);
        const prepared = Object.freeze(selection(this.#doc, request, this.#app.defaultStarter()));

        this.#requireStarter(prepared.threadType);
        this.#prepared.set(prepared, user.id);

        return prepared;
    }

    #requireStarter(type: string): void {
        if (this.#app.agentProfile(type)?.starter !== true) {
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

        this.#editor(user);
        const current = selection(doc, prepared);

        this.#requireStarter(current.threadType);

        if (current.cwd !== prepared.cwd) {
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
        const turns = await tx.doc(TurnsDoc, this.#app.rootOf(id));
        const current = this.#editor(supplied);
        const meta = sessions.items[String(id)];
        const groups = await tx.doc(HandoffsDoc);
        const group =
            meta?.workItemId === undefined ? undefined : groups.workItems[meta.workItemId];
        const members = group?.threadIds ?? [Number(id)];

        if (meta === undefined) {
            throw new HttpError(404, "No such session");
        }

        for (const memberId of members) {
            const member = sessions.items[String(memberId)];

            if (member === undefined) {
                throw new HttpError(409, "Work item membership is incomplete");
            }

            this.#see(current, memberId as ConversationId, member);
            const memberTurns = await tx.doc(TurnsDoc, memberId as ConversationId);

            if (memberTurns.on && memberTurns.driver !== current.id) {
                throw new HttpError(
                    409,
                    "Take the wheel in every work-item member before moving it",
                );
            }
        }

        if (turns.on && turns.driver !== current.id) {
            throw new HttpError(409, "Take turns is on: take the wheel before moving this thread");
        }

        if (request.projectId === undefined) {
            return;
        }

        const chosen = selection(doc, {
            projectId: optionalId(request.projectId, "projectId") ?? null,
            threadType: meta.threadType ?? "worker",
        });

        for (const memberId of members) {
            const member = sessions.items[String(memberId)]!;

            if (chosen.projectId === undefined) {
                delete member.projectId;
            } else {
                member.projectId = chosen.projectId;
            }

            member.threadType ??= "worker";
            member.updatedAt = Date.now();
        }

        await this.#app.handoffs.organization(tx);
    }
}
