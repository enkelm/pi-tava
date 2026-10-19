/** Shared live workflow policy around the remote transport and target-native confinement. */
import type { ConversationId } from "@earendil-works/pi-durable";
import type { PocketApp } from "./app.ts";
import type { SshExecutionEnv } from "./ssh-env.ts";
import { protectWorkflowEnv, type WorkflowRequester } from "./workflow-policy.ts";

export function protectSshEnv(
    app: PocketApp,
    id: ConversationId,
    env: SshExecutionEnv,
    requester?: WorkflowRequester,
): SshExecutionEnv {
    return protectWorkflowEnv(
        app,
        id,
        env,
        (readOnly, command, options, context) =>
            env.execConfined(readOnly, command, options, context),
        requester,
    );
}
