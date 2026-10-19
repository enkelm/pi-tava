/** Explicit single-file handoff from a thread's host uploads to its SSH namespace. No directory sync. */
import { open, realpath } from "node:fs/promises";
import { constants } from "node:fs";
import { basename, join, sep } from "node:path";
import { Type } from "@earendil-works/pi-ai";
import { defineTool } from "@earendil-works/pi-durable";
import { getOrThrow } from "@earendil-works/pi-durable/env";
import type { PocketApp } from "./app.ts";
import { requireWorkflowLocalWrite } from "./workflow-policy.ts";

export function createStageUploadTool(app: PocketApp) {
    return defineTool({
        name: "stage_upload",
        description:
            "Copy one attached file from this thread's host upload directory to a new private temporary directory on its SSH target. Returns the remote path for scripts. Never copies credentials, skills or directories. No automatic retry after an uncertain outcome.",
        parameters: Type.Object({
            path: Type.String({ description: "The host attachment path shown in this thread" }),
        }),
        replay: "unsafe",
        execute: async ({ path }, api, context) => {
            const id = api.conversationId;
            const root = app.rootOf(id);
            const requester = app.attribution.requesterOf(id);
            const user = requester === undefined ? undefined : app.config.userById(requester);

            if (user === undefined || app.locationOf(id) === undefined) {
                throw new Error("Staging requires an SSH thread and an authorized requester.");
            }

            app.requireSee(user, id);
            app.requireSteer(user);
            requireWorkflowLocalWrite(app, id);
            const directories = await Promise.all(
                [...new Set([root, id])].map((uploadId) =>
                    realpath(join(app.dataDir, "uploads", String(uploadId))).catch(() => undefined),
                ),
            );
            const canonical = await realpath(path);

            if (
                !directories.some(
                    (directory) => directory !== undefined && canonical.startsWith(directory + sep),
                )
            ) {
                throw new Error("Only attachments uploaded to this thread can be staged.");
            }

            const file = await open(canonical, constants.O_RDONLY | constants.O_NOFOLLOW);
            let bytes: Buffer;

            try {
                const info = await file.stat();

                if (!info.isFile() || info.size > 25 * 1024 * 1024) {
                    throw new Error("Only attached regular files up to 25 MiB can be staged.");
                }

                // A bounded read even if another host writer grows the attachment after stat.
                bytes = Buffer.alloc(info.size + 1);
                const read = await file.read(bytes, 0, bytes.length, 0);

                if (read.bytesRead !== info.size) {
                    throw new Error(
                        "Attachment changed while reading; inspect it before trying again.",
                    );
                }

                bytes = bytes.subarray(0, read.bytesRead);
            } finally {
                await file.close();
            }

            const current = app.config.userById(user.id);

            if (current === undefined) {
                throw new Error("The upload requester's access was removed.");
            }

            app.requireSee(current, id);
            app.requireSteer(current);
            requireWorkflowLocalWrite(app, id);
            const env = app.envFor(id, current);
            const temporary = getOrThrow(await env.createTempDir("coop-upload-", context));
            const destination = getOrThrow(
                await env.joinPath([temporary, basename(canonical)], context),
            );

            getOrThrow(await env.writeFile(destination, bytes, context));

            return {
                content: [
                    {
                        type: "text",
                        text: `Staged on SSH · ${app.locationOf(id)!.host}: ${destination}\nThe original remains on the Coop host. The remote temporary file is not automatically removed.`,
                    },
                ],
            };
        },
    });
}
