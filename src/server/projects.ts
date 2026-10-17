/** Durable project and goal membership, independent of working folders, thread type and access. */
import { createHash, randomUUID } from "node:crypto";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import type { ConversationId, Tx } from "@earendil-works/pi-durable";
import type { PocketApp } from "./app.ts";
import type { User } from "./config.ts";
import {
    type Project,
    type ProjectGoal,
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
    goalId?: string;
    newGoal?: boolean;
    threadType: ThreadType;
    cwd?: string;
};

export type ProjectPlacement = { projectId?: string; goalId?: string; threadType: ThreadType };
export type SelectProject = {
    projectId?: unknown;
    goalId?: unknown;
    newGoal?: unknown;
    threadType?: unknown;
};
export type CreateProject = { name?: unknown; cwd?: unknown; requestId?: unknown };
export type UpdateProject = { name?: unknown; cwd?: unknown };
export type UpdateProjectGoal = { name?: unknown; status?: unknown; archived?: unknown };
export type AssignProject = { projectId?: unknown; goalId?: unknown };

function empty(): ProjectsData {
    return { projects: {}, goals: {}, requests: {} };
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

function goal(doc: ProjectsData, id: string): ProjectGoal {
    if (!Object.hasOwn(doc.goals, id)) {
        throw new HttpError(404, "No such project goal");
    }

    return doc.goals[id]!;
}

function selection(
    doc: ProjectsData,
    request: SelectProject,
    defaultStarter?: string,
): ProjectSelection {
    let projectId = optionalId(request.projectId, "projectId");
    const goalId = optionalId(request.goalId, "goalId");
    const selectedGoal = goalId === undefined ? undefined : goal(doc, goalId);

    if (selectedGoal !== undefined && projectId === undefined && request.projectId === undefined) {
        projectId = selectedGoal.projectId;
    }

    const selectedProject = projectId === undefined ? undefined : project(doc, projectId);

    if (selectedGoal !== undefined && selectedGoal.projectId !== projectId) {
        throw new HttpError(400, "The goal must belong to the selected project");
    }

    if (selectedGoal?.archived === true) {
        throw new HttpError(409, "Restore the goal before adding a thread to it");
    }

    if (request.newGoal !== undefined && typeof request.newGoal !== "boolean") {
        throw new HttpError(400, "newGoal must be a boolean");
    }

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

    if (
        request.newGoal === true &&
        (projectId === undefined || goalId !== undefined || threadType === "chat")
    ) {
        throw new HttpError(
            400,
            "A new goal needs a project and a non-Chat starter thread without an existing goal",
        );
    }

    return {
        ...(projectId === undefined ? {} : { projectId }),
        ...(goalId === undefined ? {} : { goalId }),
        ...(request.newGoal === true ? { newGoal: true } : {}),
        threadType: threadType as ProjectSelection["threadType"],
        ...(selectedProject === undefined ? {} : { cwd: selectedProject.cwd }),
    };
}

export class Projects {
    readonly #app: PocketApp;
    #doc: ProjectsData = empty();
    /** Only server-prepared selections can publish new goals, with their original authenticated creator. */
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

    /** Remembering a goal ID never grants access to a goal now occupied only by hidden threads. */
    #requireGoalVisible(
        user: User,
        id: string,
        members: Iterable<readonly [string, SessionMeta]>,
    ): void {
        if (user.role === "owner") {
            return;
        }

        let occupied = false;

        for (const [threadId, meta] of members) {
            if (meta.goalId !== id) {
                continue;
            }

            occupied = true;

            if (
                meta.ownerOnly !== true &&
                this.#app.canSee(user, Number(threadId) as ConversationId)
            ) {
                return;
            }
        }

        if (occupied) {
            throw new HttpError(404, "No such project goal");
        }
    }

    list(supplied: User): { projects: Project[]; goals: ProjectGoal[] } {
        const user = this.#person(supplied);
        const visible = this.#app.sessions(user);
        const projectIds = new Set(
            visible.flatMap((item) => (item.projectId === undefined ? [] : [item.projectId])),
        );
        const goalIds = new Set(
            visible.flatMap((item) => (item.goalId === undefined ? [] : [item.goalId])),
        );
        const visibleIds = new Set(visible.map((item) => item.id));
        const scoped = user.sessions !== undefined;
        const all = !scoped && user.role !== "owner" ? this.#app.sessions() : visible;
        const occupiedGoalIds = new Set(
            all.flatMap((item) => (item.goalId === undefined ? [] : [item.goalId])),
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
        const goals = Object.values(this.#doc.goals)
            .filter((item) => Object.hasOwn(this.#doc.projects, item.projectId))
            .filter((item) =>
                scoped
                    ? goalIds.has(item.id) && projectIds.has(item.projectId)
                    : user.role === "owner" ||
                      !occupiedGoalIds.has(item.id) ||
                      goalIds.has(item.id),
            )
            .map((item) => {
                const copy = { ...item };

                // Task receipts and hidden naming-thread ids are not part of the public catalogue.
                delete copy.namingTaskId;

                if (copy.namingThreadId !== undefined && !visibleIds.has(copy.namingThreadId)) {
                    delete copy.namingThreadId;
                }

                return copy;
            });

        return { projects, goals };
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

    async updateGoal(supplied: User, id: string, request: UpdateProjectGoal): Promise<void> {
        this.#editor(supplied);
        const name = request.name === undefined ? undefined : text(request.name, "name", MAX_NAME);
        const status = request.status;
        const archived = request.archived;

        if (status !== undefined && status !== "active" && status !== "completed") {
            throw new HttpError(400, "status must be active or completed");
        }

        if (archived !== undefined && typeof archived !== "boolean") {
            throw new HttpError(400, "archived must be a boolean");
        }

        await this.#app.harness.commit(async (tx) => {
            const doc = await tx.doc(ProjectsDoc);
            const sessions = await tx.doc(SessionsDoc);
            const user = this.#editor(supplied);
            const item = goal(doc, id);
            const targets = Object.entries(sessions.items).filter(([, meta]) => meta.goalId === id);

            // Do not partially update a goal containing an owner-only thread, or reveal its details.
            for (const [threadId, meta] of targets) {
                this.#see(user, Number(threadId) as ConversationId, meta);
            }

            const now = Date.now();

            if (archived !== undefined) {
                for (const [, meta] of targets) {
                    if (archived && meta.archived !== true) {
                        meta.archived = true;
                        meta.archivedByGoal = id;
                    } else if (!archived && meta.archivedByGoal === id) {
                        meta.archived = false;
                        delete meta.archivedByGoal;
                    }
                }

                item.archived = archived;
            }

            if (status !== undefined) {
                item.status = status;
            }

            if (name !== undefined) {
                item.name = name;
                item.named = true;
            }

            if (name !== undefined || status !== undefined || archived !== undefined) {
                item.updatedAt = now;
            }

            await this.#app.handoffs.organization(tx);
        }, context);
    }

    /** Validate before worktree creation without creating either a goal or a conversation. */
    prepare(supplied: User, request: SelectProject): ProjectSelection {
        const user = this.#editor(supplied);
        const goalId = optionalId(request.goalId, "goalId");

        if (goalId !== undefined) {
            goal(this.#doc, goalId);
            this.#requireGoalVisible(
                user,
                goalId,
                this.#app.sessions().map((item) => [String(item.id), item] as const),
            );
        }

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
    async place(tx: Tx, id: ConversationId, prepared: ProjectSelection): Promise<ProjectPlacement> {
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

        if (prepared.goalId !== undefined) {
            this.#requireGoalVisible(
                user,
                prepared.goalId,
                Object.entries((await tx.doc(SessionsDoc)).items),
            );
        }

        const current = selection(doc, prepared);

        this.#requireStarter(current.threadType);

        if (current.cwd !== prepared.cwd) {
            throw new HttpError(409, "The project folder changed; try starting the session again");
        }

        let goalId = current.goalId;

        if (current.newGoal === true) {
            goalId = `g-${randomUUID()}`;
            const now = Date.now();

            doc.goals[goalId] = {
                id: goalId,
                projectId: current.projectId!,
                name: "New goal",
                status: "active",
                namingThreadId: Number(id),
                named: false,
                createdAt: now,
                updatedAt: now,
                createdBy: user.id,
            };
        }

        return {
            ...(current.projectId === undefined ? {} : { projectId: current.projectId }),
            ...(goalId === undefined ? {} : { goalId }),
            threadType: current.threadType,
        };
    }

    async assign(supplied: User, id: ConversationId, request: AssignProject): Promise<void> {
        const user = this.#editor(supplied);

        this.#app.requireSee(user, id);

        if (Object.hasOwn(request, "newGoal") || Object.hasOwn(request, "threadType")) {
            throw new HttpError(400, "Moving a thread cannot create a goal or change its type");
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

        if (request.projectId === undefined && request.goalId === undefined) {
            return;
        }

        const projectId =
            request.projectId === undefined
                ? meta.projectId
                : optionalId(request.projectId, "projectId");
        const goalId =
            request.goalId === undefined
                ? projectId === meta.projectId
                    ? meta.goalId
                    : undefined
                : optionalId(request.goalId, "goalId");

        if (goalId !== undefined) {
            this.#requireGoalVisible(current, goalId, Object.entries(sessions.items));
        }

        const chosen = selection(doc, {
            ...(goalId !== undefined &&
            request.goalId !== undefined &&
            request.projectId === undefined
                ? {}
                : { projectId: projectId ?? null }),
            goalId,
            threadType: meta.threadType ?? "worker",
        });

        for (const memberId of members) {
            const member = sessions.items[String(memberId)]!;

            if (chosen.projectId === undefined) {
                delete member.projectId;
            } else {
                member.projectId = chosen.projectId;
            }

            if (chosen.goalId === undefined) {
                delete member.goalId;
            } else {
                member.goalId = chosen.goalId;
            }

            if (member.archivedByGoal !== undefined && member.archivedByGoal !== chosen.goalId) {
                delete member.archivedByGoal;
            }

            member.threadType ??= "worker";
            member.updatedAt = Date.now();
        }

        await this.#app.handoffs.organization(tx);
    }

    /** A delayed AI name may only claim its original unnamed goal and naming thread. */
    async nameGoal(
        tx: Tx,
        threadId: ConversationId,
        title: string,
        expectedGoalId?: string,
    ): Promise<void> {
        const doc = await tx.doc(ProjectsDoc);
        const sessions = await tx.doc(SessionsDoc);
        const meta = sessions.items[String(threadId)];
        const item =
            meta?.goalId === undefined || !Object.hasOwn(doc.goals, meta.goalId)
                ? undefined
                : doc.goals[meta.goalId];

        if (
            item === undefined ||
            item.named === true ||
            item.namingThreadId !== Number(threadId) ||
            item.projectId !== meta?.projectId ||
            (expectedGoalId !== undefined && item.id !== expectedGoalId)
        ) {
            return;
        }

        item.name = text(title, "name", MAX_NAME);
        item.named = true;
        item.updatedAt = Date.now();
    }
}
