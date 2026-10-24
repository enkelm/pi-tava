/** Invocation-bound controller adapter for the public handoff tool; execution remains in the native transfer engine. */
import type { Context } from "@earendil-works/chord";
import type { ConversationId, ToolExecutionApi } from "@earendil-works/pi-durable";
import type { PocketApp } from "../app.ts";
import type { HandoffResult } from "../handoffs.ts";
import { TurnsDoc } from "../docs.ts";
import { HttpError } from "../errors.ts";
import { PublicationsDoc } from "../workflow-publication.ts";
import { workflowExclusiveReason } from "../workflow-policy.ts";

export type ControllerHandoffRequest = {
    action: "status" | "start";
    session?: number;
    targetType?: string;
    relationship?: "same-work" | "new-work";
    worktree?: boolean;
    summary?: string;
    instructions?: string;
    /** Other actors may accept creation fields; this adapter rejects them, never ignores them. */
    [field: string]: unknown;
};

function requireFields(request: ControllerHandoffRequest, allowed: readonly string[]): void {
    if (
        Object.entries(request).some(
            ([field, value]) => value !== undefined && !allowed.includes(field),
        )
    ) {
        throw new HttpError(
            400,
            "A controller handoff cannot create unrelated work or choose creation settings.",
        );
    }
}

/** The controller's registered-profile policy intentionally does not apply ordinary role/diff edges. */
async function status(
    app: PocketApp,
    request: ControllerHandoffRequest,
    api: ToolExecutionApi,
    ctx: Context,
    epoch: number,
) {
    const controller = api.conversationId;
    const item = app.workItems.itemFor(controller);
    const source = (request.session ?? item?.activeThreadId) as ConversationId | undefined;

    if (source === undefined) {
        throw new HttpError(409, "This controller has no active execution thread.");
    }

    await api.commit(
        (tx) => app.workItems.requireController(tx, controller, epoch, source),
        ctx,
    );

    let reason = workflowExclusiveReason(app, source);

    try {
        app.pip.requireHandoffInspection(controller, Number(source));
        app.workItems.requireWritable(source);

        if (app.sessionMeta(source)?.archived === true) {
            throw new HttpError(409, "Restore the work item first");
        }

        await api.commit(async (tx) => {
            const turns = await tx.doc(TurnsDoc, source);
            const user = await app.workItems.requireController(tx, controller, epoch, source);
            const grant = app.workItems.itemFor(controller)!.supervisor!;

            app.spend.check(user, controller);
            app.spend.check(user, source);

            if (grant.maxActions !== undefined && grant.actions >= grant.maxActions) {
                throw new HttpError(409, "The work action budget is exhausted; ask the human to extend it.");
            }

            if (turns.on && turns.driver !== user.id) {
                throw new HttpError(409, "Take the wheel before starting a handoff");
            }

            for (const member of app.workItems.members(source)) {
                const publications = await tx.doc(PublicationsDoc, member);

                if (
                    Object.values(publications.receipts).some(
                        (receipt) => receipt.state === "executing",
                    )
                ) {
                    throw new HttpError(
                        409,
                        "Reconcile uncertain publication actions before handing off this work item",
                    );
                }
            }

            // The controller invocation is not execution work: exempt no execution/helper tasks.
            await app.workItems.requireIdle(tx, source);
        }, ctx);
    } catch (error) {
        if (!(error instanceof HttpError)) {
            throw error;
        }

        reason ??= error.message;
    }

    const user = await api.commit(
        (tx) => app.workItems.requireController(tx, controller, epoch, source),
        ctx,
    );

    reason ??= workflowExclusiveReason(app, source);

    return {
        ...app.workItems.context(source, user),
        sourceThreadId: Number(source),
        options: app.workItems.profiles().map((profile) => ({
            targetType: profile.id,
            relationship: "same-work" as const,
            description: profile.description,
            enabled: reason === undefined,
            ...(reason === undefined ? {} : { reason }),
        })),
    };
}

export async function controllerHandoff(
    app: PocketApp,
    request: ControllerHandoffRequest,
    api: ToolExecutionApi,
    ctx: Context,
): Promise<HandoffResult | Awaited<ReturnType<typeof status>>> {
    const controller = api.conversationId;

    if (controller !== app.rootOf(controller) || !app.pip.orchestration.isScoped(controller)) {
        throw new HttpError(403, "Only this Work Item's main controller may hand off execution.");
    }

    if (
        request.session !== undefined &&
        (!Number.isSafeInteger(request.session) || request.session <= 0)
    ) {
        throw new HttpError(400, "session must name an exact execution thread.");
    }

    if (request.action === "status") {
        requireFields(request, ["action", "session"]);
    } else if (request.action === "start") {
        requireFields(request, [
            "action",
            "session",
            "targetType",
            "relationship",
            "summary",
            "instructions",
        ]);

        if (request.session === undefined) {
            throw new HttpError(
                400,
                "A controller handoff requires the exact expected execution session.",
            );
        }

        if (request.relationship !== undefined && request.relationship !== "same-work") {
            throw new HttpError(
                400,
                "A controller can only hand off within its current Work Item.",
            );
        }

        if (typeof request.targetType !== "string" || typeof request.summary !== "string") {
            throw new HttpError(400, "A controller handoff requires targetType and summary.");
        }

        if (request.instructions !== undefined && typeof request.instructions !== "string") {
            throw new HttpError(400, "instructions must be text.");
        }
    } else {
        throw new HttpError(400, "Unknown controller handoff action.");
    }

    return app.pip.orchestration.perform<HandoffResult | Awaited<ReturnType<typeof status>>>(
        api,
        ctx,
        (epoch) => {
            if (epoch === undefined) {
                throw new HttpError(
                    403,
                    "This handoff has no native controller generation authority.",
                );
            }

            if (request.action === "status") {
                return status(app, request, api, ctx, epoch);
            }

            // Do not preflight mutable eligibility here: the engine must recover committed receipts
            // before checking whether the old source is still active or its destination is available.
            return app.pip.controllerHandoff(
                controller,
                request.session!,
                {
                    targetType: request.targetType!,
                    summary: request.summary!,
                    ...(request.instructions === undefined
                        ? {}
                        : { instructions: request.instructions }),
                },
                api,
                ctx,
                epoch,
            );
        },
        { passive: request.action === "status" },
    );
}
