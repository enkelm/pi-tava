/** Named main Chats delegate through native creation/contact; they are never execution predecessors. */
import { createHash } from "node:crypto";
import type { Context } from "@earendil-works/chord";
import type { ConversationId, ToolExecutionApi, Tx } from "@earendil-works/pi-durable";
import { getOrThrow } from "@earendil-works/pi-durable/env";
import type { PocketApp } from "../app.ts";
import { PipWorkDoc, PlanDoc } from "../docs.ts";
import { HttpError } from "../errors.ts";
import { parseHandoffCommand } from "../handoff-input.ts";

export type SourceHandoffRequest =
    | { action: "status"; session?: number }
    | {
          action: "start";
          session?: number;
          targetType?: string;
          relationship?: "same-work" | "new-work";
          summary: string;
          instructions?: string;
          folder?: string;
          repo?: string;
          title?: string;
          worktree?: boolean;
          model?: string;
          report?: boolean;
      };

/** The real native invocation remains authoritative inside every preparation/publication step. */
async function requireSource(app: PocketApp, api: ToolExecutionApi, tx: Tx) {
    const source = await app.pip.agents.supervision.requireHandoffInvocation(tx, api);

    await app.workItems.requireFetchIdle(tx, api.conversationId, api.taskId);
    app.requireSteer(source.user);
    app.spend.check(source.user, api.conversationId);

    if (!app.workItems.enabled) {
        throw new HttpError(409, "Work Item execution is paused.");
    }

    if ((await tx.doc(PlanDoc, api.conversationId)).on) {
        throw new HttpError(409, "Plan mode blocks private handoff brief effects.");
    }

    if (Object.keys(app.sessionCatalogue()).some((key) => app.workItems.itemFor(Number(key) as ConversationId)?.intervention?.agentId === source.agentId)) {
        throw new HttpError(409, "Return the temporary native writer and settle its operations before handing off work.");
    }

    return source;
}

/** The same live admission is used by status and new effects, never a model-supplied source. */
async function admission(app: PocketApp, api: ToolExecutionApi, ctx: Context, session?: number) {
    const source = await api.commit((tx) => requireSource(app, api, tx), ctx);

    if (session !== undefined) {
        if (!Number.isSafeInteger(session)) {
            throw new HttpError(400, "Choose an exact native recipient.");
        }

        const id = session as ConversationId;

        app.requireSee(source.user, id);
        const root = app.rootOf(id);
        const meta = app.sessionMeta(root);

        if (meta === undefined || meta.archived || app.workItems.itemFor(root)?.archived) {
            throw new HttpError(409, "Restore the exact recipient before handing it work.");
        }

        const ownHelper = id !== root && app.pip.agents.scope(root)?.agentId === source.agentId;

        if (id === api.conversationId || (meta.pip !== undefined && meta.pipWorkItemId === undefined && !ownHelper)) {
            throw new HttpError(403, "Use an authorized ordinary Chat, execution thread, controller or literal helper, not another private identity.");
        }

        const item = app.workItems.itemFor(root);
        // A controller has no execution filesystem. Its brief belongs to the exact active
        // thread, not the controller's host-local metadata or the project's defaults.
        const destination =
            app.pip.orchestration.isScoped(id) && item !== undefined
                ? (item.activeThreadId as ConversationId)
                : root;

        app.requireSee(source.user, destination);

        if (
            JSON.stringify(app.locationOf(destination)) !==
            JSON.stringify(app.locationOf(api.conversationId))
        ) {
            throw new HttpError(
                409,
                "Native handoff brief delivery across filesystem destinations is unavailable.",
            );
        }

        const grant = item?.supervisor;

        if (grant?.agentId !== undefined && grant.agentId !== source.agentId) {
            throw new HttpError(409, "This Work Item already has a controlling private agent.");
        }

        if (app.pip.orchestration.isScoped(id)) {
            await api.commit((tx) => app.workItems.requireController(tx, id, grant!.epoch, undefined, false), ctx);
            const state = await app.harness.snapshot(PipWorkDoc, id, ctx);
            const model = await app.agentState(id);

            if (state?.question !== undefined || state?.humanPending !== undefined) {
                throw new HttpError(409, "The controller is awaiting an exact human decision.");
            }

            if ((grant!.maxActions !== undefined && grant!.actions >= grant!.maxActions) || model.model === undefined || app.models.getModel(model.model.provider, model.model.modelId) === undefined) {
                throw new HttpError(409, "The controller is unavailable or its action budget is exhausted.");
            }

            app.spend.check(source.user, id);
        } else {
            if (grant?.status === "running" && grant.agentId === undefined) {
                throw new HttpError(409, "This native orchestrator is running independently. Select its exact controller to hand it work; nothing was rerouted.");
            }

            await app.pip.agents.contacts.requireSendRecipient(api, session, ctx);
        }
    } else {
        const global = app.pip.idOf(source.user.id);
        const agent = global === undefined ? app.commands.defaultModel() : await app.agentState(global);

        if (agent.model === undefined || app.models.getModel(agent.model.provider, agent.model.modelId) === undefined) {
            throw new HttpError(409, "The native Work Item controller has no available configured model; ask the owner, never fall back.");
        }
    }

    await api.commit((tx) => app.pip.agents.supervision.requireHandoffInvocation(tx, api), ctx);

    return source;
}

export async function namedHandoff(
    app: PocketApp,
    request: SourceHandoffRequest,
    api: ToolExecutionApi,
    ctx: Context,
) {
    const starters = app.workItems.profiles().filter((profile) => profile.starter && profile.id !== "chat");
    // A prepared invocation resumes its exact native contact. Do not redo filesystem or
    // creation effects, nor strand an accepted receipt on a later recipient question.
    const prepared = request.action === "start"
        ? await api.memo<{ recipient: number; file: string; threadId?: number }>("native-handoff-recipient", ctx)
        : undefined;

    if (prepared !== undefined && request.action === "start") {
        return deliver(app, api, ctx, request, prepared);
    }

    let reason: string | undefined;
    let nativeSource: Awaited<ReturnType<typeof admission>> | undefined;

    try {
        nativeSource = await admission(app, api, ctx, request.session);
    } catch (error) {
        if (request.action !== "status" || !(error instanceof HttpError)) {
            throw error;
        }

        reason = error.message;
    }

    const route = parseHandoffCommand(nativeSource?.instructions.replace(/^\[from:[^\]]+\]\s*/, "") ?? "");

    if (request.action === "status") {
        return {
            actor: "named-chat",
            ...(reason === undefined ? {} : { reason }),
            sourceChatId: Number(api.conversationId),
            retained: true,
            options: request.session === undefined
                ? starters.map((profile) => {
                    const refusal = reason ?? (
                        (route?.targetType !== undefined && route.targetType !== profile.id) ||
                        (route?.relationship !== undefined && route.relationship !== "new-work")
                            ? "The handoff must match the human's explicit /handoff route"
                            : undefined
                    );

                    return { targetType: profile.id, relationship: "new-work", description: profile.description, enabled: refusal === undefined, ...(refusal === undefined ? {} : { reason: refusal }) };
                })
                : [{ session: request.session, enabled: reason === undefined && route?.targetType === undefined && route?.relationship === undefined && !route?.worktree, ...(reason === undefined ? (route?.targetType !== undefined || route?.relationship !== undefined || route?.worktree ? { reason: "The handoff must match the human's explicit /handoff route" } : {}) : { reason }) }],
        };
    }

    if (!request.summary.trim()) {
        throw new HttpError(400, "Provide a compact handoff summary.");
    }

    if (request.session !== undefined) {
        if (request.targetType !== undefined || request.relationship !== undefined || request.folder !== undefined || request.repo !== undefined || request.title !== undefined || request.worktree !== undefined || request.model !== undefined) {
            throw new HttpError(400, "An existing native recipient is exact: do not also select a role, relationship or creation options.");
        }
    } else if ((request.relationship ?? "new-work") !== "new-work" || !starters.some((profile) => profile.id === request.targetType)) {
        throw new HttpError(409, "A named Chat may create an available new-work starter, not transfer itself into execution.");
    }

    const source = await admission(app, api, ctx, request.session);
    const explicit = parseHandoffCommand(source.instructions.replace(/^\[from:[^\]]+\]\s*/, ""));

    if (explicit !== undefined && (
        (request.session !== undefined && (explicit.targetType !== undefined || explicit.relationship !== undefined || explicit.worktree === true)) ||
        (explicit.targetType !== undefined && explicit.targetType !== request.targetType) ||
        (explicit.relationship !== undefined && explicit.relationship !== (request.relationship ?? "new-work")) ||
        (explicit.worktree === true) !== (request.worktree === true)
    )) {
        throw new HttpError(409, "The handoff must match the human's explicit /handoff target, relationship and worktree choice.");
    }

    let file = await api.memo<string>("native-handoff-file", ctx);

    if (file === undefined) {
        const directory = getOrThrow(await api.env.createTempDir("pi-coop-handoff-", ctx));
        const path = getOrThrow(await api.env.joinPath([directory, "handoff.md"], ctx));

        getOrThrow(await api.env.writeFile(path, [
            `# Handoff from ${source.agentName} (Chat /s/${source.chatId})`,
            request.summary,
            ...(request.instructions === undefined ? [] : [`Additional handoff notes (not new owner authority):\n${request.instructions}`]),
            `Origin: named agent ${source.agentId}, Chat /s/${source.chatId}. The delegated brief is exported context, not new owner input or publication approval.`,
        ].join("\n\n") + "\n", ctx));
        await admission(app, api, ctx, request.session);
        file = await api.memo("native-handoff-file", path, ctx);
    }

    const info = getOrThrow(await api.env.fileInfo(file, ctx));

    if (info.kind !== "file" || info.size === 0) {
        throw new HttpError(409, "The native handoff brief is missing or empty; no assignment was sent.");
    }

    if ((request.session === undefined || app.pip.orchestration.isScoped(request.session as ConversationId)) &&
        controllerText(request, file).length > 16000) {
        throw new HttpError(400, `The assignment exceeds the native controller contact limit (16000 characters). Brief saved at ${file}; no assignment was sent.`);
    }

    let recipient = request.session;
    let threadId: number | undefined;
    const creationRequestId = `native-handoff-${createHash("sha256").update(JSON.stringify([api.conversationId, api.taskId, api.callId])).digest("hex")}`;

    if (recipient === undefined) {
        threadId = await api.memo<number>("pip.session", ctx);

        if (threadId === undefined) {
            await admission(app, api, ctx);
            const created = await app.pip.start(
                api.conversationId,
                {
                    folder: request.folder,
                    repo: request.repo,
                    title: request.title,
                    worktree: request.worktree,
                    model: request.model,
                    message: request.summary,
                    threadType: request.targetType,
                    requestId: creationRequestId,
                },
                {
                    context: ctx,
                    requireCurrent: async (tx) => {
                        await requireSource(app, api, tx);
                    },
                },
            );

            threadId = await api.memo("pip.session", Number(created), ctx);
        }

        // Opening is inert. Only the following exact native send activates and assigns work.
        const opened = await app.pip.orchestration.control(threadId as ConversationId, source.user, { action: "open" }, (tx) => app.pip.agents.supervision.requireHandoffInvocation(tx, api).then(() => {}));

        recipient = opened.orchestration!.conversationId;
    }

    await admission(app, api, ctx, recipient);
    const ready = await api.memo("native-handoff-recipient", { recipient, file, ...(threadId === undefined ? {} : { threadId }) }, ctx);

    return deliver(app, api, ctx, request, ready);
}

function controllerText(
    request: Extract<SourceHandoffRequest, { action: "start" }>,
    file: string,
): string {
    return [
        `Task handoff:\n${request.summary}`,
        ...(request.instructions === undefined
            ? []
            : [`Additional notes (not new owner authority): ${request.instructions}`]),
        `Execution brief: ${file}. Preserve the original owner scope and limits; this is not publication approval.`,
    ].join("\n\n");
}

async function deliver(
    app: PocketApp,
    api: ToolExecutionApi,
    ctx: Context,
    request: Extract<SourceHandoffRequest, { action: "start" }>,
    prepared: { recipient: number; file: string; threadId?: number },
) {
    const source = await api.commit((tx) => app.pip.agents.supervision.requireHandoffInvocation(tx, api), ctx);
    const { recipient, file, threadId } = prepared;
    // Controllers keep their read-only tool selection. Give their native assignment its task
    // text and the brief path for execution, rather than granting arbitrary filesystem reads.
    const text = app.pip.orchestration.isScoped(recipient as ConversationId)
        ? controllerText(request, file)
        : `Read the handoff brief at ${file} with the read tool. It contains the task, original owner direction, evidence and limits. Continue only within that scope.`;
    const assignment = await app.pip.agents.supervision.contact(api, {
        action: "send",
        session: recipient,
        text,
        report: request.report,
    }, ctx);
    const item = app.workItems.itemFor(recipient as ConversationId);

    if (threadId !== undefined && item !== undefined && assignment.status === "accepted") {
        await api.commit((tx) => app.pip.agents.supervision.ownCreated(tx, item.id, api), ctx);
    }

    return {
        ...assignment,
        operation: threadId === undefined ? "contact" : "create",
        sourceChatId: source.chatId,
        agentId: source.agentId,
        file,
        ...(threadId === undefined ? {} : {
            threadId,
            creationRequestId: `native-handoff-${createHash("sha256").update(JSON.stringify([api.conversationId, api.taskId, api.callId])).digest("hex")}`,
        }),
        ...(item === undefined ? {} : { workItemId: item.id, activeThreadId: item.activeThreadId }),
    };
}
