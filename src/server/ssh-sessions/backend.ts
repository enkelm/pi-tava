/** Guarded backend assembly shared by local factories and SSHSessions, never a raw transport interface. */
import type { Context } from "@earendil-works/chord";
import type { ConversationId } from "@earendil-works/pi-durable";
import type { ExecutionEnv } from "@earendil-works/pi-durable/env";
import type { PocketApp } from "../app.ts";
import type { User } from "../config.ts";
import { requireWorkflowRequester, reserveWorkflowLocalWrite } from "../workflow-policy.ts";
import {
    WorkspaceBackend,
    type ConfinedExec,
    type WorkspaceInspection,
} from "../workspace-backend.ts";

const writes = new Set([
    "writeFile",
    "appendFile",
    "truncateFile",
    "flushFile",
    "renameFile",
    "createDir",
    "remove",
    "createTempDir",
    "createTempFile",
]);

export function workspaceAuthorization(
    app: PocketApp,
    id: ConversationId,
    user: User,
    agent: boolean,
) {
    const identity = {
        id: user.id,
        tokenHash: user.tokenHash,
        role: user.role,
        sessions: user.sessions?.slice(),
        projectAccess:
            user.projectAccess === undefined
                ? undefined
                : {
                      ...user.projectAccess,
                      hosts: user.projectAccess.hosts?.slice(),
                      projectIds: user.projectAccess.projectIds?.slice(),
                  },
    };
    const cwd = app.cwdOf(id);
    const location = JSON.stringify(app.locationOf(id));
    const projectId = app.sessionMeta(app.rootOf(id))?.projectId;

    return (write: boolean) => {
        requireWorkflowRequester(app, id, identity, !write);

        if (agent && requireWorkflowRequester(app, id) !== identity.id) {
            throw new Error("The workflow requester changed; no operation was started.");
        }

        if (
            JSON.stringify(app.locationOf(id)) !== location ||
            app.cwdOf(id) !== cwd ||
            app.sessionMeta(app.rootOf(id))?.projectId !== projectId
        ) {
            throw new Error("The workspace destination changed; no operation was started.");
        }

        if (write) {
            app.handoffs.requireWritable(id);
        }
    };
}

export function guardedBackend(options: {
    raw: ExecutionEnv;
    context: Context;
    remote: boolean;
    authorize(write: boolean): void;
    confinedExec?: ConfinedExec;
    reserveWrite?: () => () => void;
    managed(): boolean;
}): WorkspaceBackend {
    const { raw, context, remote, authorize, reserveWrite } = options;
    const env = new Proxy(raw, {
        get(target, property) {
            if (property === "execConfined") {
                return undefined;
            }

            const value = Reflect.get(target, property, target);

            if (typeof value !== "function") {
                return value;
            }

            if (property === "cleanup") {
                return value.bind(target);
            }

            return async (...args: unknown[]) => {
                const write = writes.has(String(property));

                authorize(write);
                const release = write ? reserveWrite?.() : undefined;

                try {
                    if (property === "exec" && options.managed()) {
                        throw new Error(
                            "Use the trusted backend Git operation for managed workspace inspection.",
                        );
                    }

                    const result = await Reflect.apply(value, target, args);

                    authorize(write);

                    return result;
                } finally {
                    release?.();
                }
            };
        },
    }) as ExecutionEnv;
    const inspection: WorkspaceInspection | undefined = remote
        ? {
              lstat: (path, ctx) => (env as ExecutionEnv & WorkspaceInspection).lstat(path, ctx),
              readlink: (path, ctx) =>
                  (env as ExecutionEnv & WorkspaceInspection).readlink(path, ctx),
          }
        : undefined;

    return new WorkspaceBackend(env, {
        remote,
        context,
        inspection,
        authorize,
        confinedExec:
            options.confinedExec === undefined
                ? undefined
                : async (command, execOptions, ctx, readOnly) => {
                      authorize(!readOnly);
                      const result = await options.confinedExec!(
                          command,
                          execOptions,
                          ctx,
                          readOnly,
                      );

                      authorize(!readOnly);

                      return result;
                  },
        offline: options.managed,
        ...(reserveWrite === undefined ? {} : { reserveWrite }),
    });
}

export function writerReservation(app: PocketApp, id: ConversationId) {
    return () => reserveWorkflowLocalWrite(app, id);
}
