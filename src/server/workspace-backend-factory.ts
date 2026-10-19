/** Host-owned workspace capabilities. SSHSessions hides remote identity, confinement and transport assembly. */
import type { Context } from "@earendil-works/chord";
import type { ConversationId } from "@earendil-works/pi-durable";
import { NodeExecutionEnv } from "@earendil-works/pi-durable/env/node";
import type { PocketApp } from "./app.ts";
import type { User } from "./config.ts";
import { requireWorkflowRequester } from "./workflow-policy.ts";
import {
    guardedBackend,
    workspaceAuthorization,
    writerReservation,
} from "./ssh-sessions/backend.ts";
import type { WorkspaceBackend } from "./workspace-backend.ts";

/** Trusted core operations already owning an exclusive workflow operation, or read-only inspection. */
export function workflowWorkspaceBackend(
    app: PocketApp,
    id: ConversationId,
    context: Context,
): WorkspaceBackend {
    return backend(app, id, context, undefined, true);
}

/** Direct UI operations retain writer reservations and the exact supplied human identity. */
export function userWorkspaceBackend(
    app: PocketApp,
    id: ConversationId,
    context: Context,
    user?: User,
): WorkspaceBackend {
    return backend(app, id, context, user, false);
}

function backend(
    app: PocketApp,
    id: ConversationId,
    context: Context,
    user: User | undefined,
    exclusive: boolean,
): WorkspaceBackend {
    if (app.locationOf(id) !== undefined) {
        return app.sshSessions.backend(id, user, context, exclusive);
    }

    const requester = structuredClone(
        user ?? app.config.userById(requireWorkflowRequester(app, id))!,
    );
    const authorize = workspaceAuthorization(app, id, requester, user === undefined);

    authorize(false);

    return guardedBackend({
        raw: new NodeExecutionEnv({ cwd: app.cwdOf(id) }),
        remote: false,
        context,
        authorize,
        managed: () => app.workItems.isManaged(id),
        ...(exclusive ? {} : { reserveWrite: writerReservation(app, id) }),
    });
}
