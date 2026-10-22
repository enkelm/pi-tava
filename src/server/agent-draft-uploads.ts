/** Owner/identity-scoped attachment staging, without reserving an empty conversation. */
import { createHash } from "node:crypto";
import { constants, copyFileSync, lstatSync, mkdirSync } from "node:fs";
import { basename, dirname, join, resolve } from "node:path";
import type { ConversationId } from "@earendil-works/pi-durable";
import type { PocketApp } from "./app.ts";
import type { Attachment } from "./commands.ts";
import type { User } from "./config.ts";
import { HttpError } from "./errors.ts";

export function draftUploadDirectory(app: PocketApp, user: User, agentId: string): string {
    const scope = createHash("sha256")
        .update(JSON.stringify([user.id, agentId]))
        .digest("hex");
    const directory = resolve(app.dataDir, "uploads", "agent-drafts", scope);

    mkdirSync(directory, { recursive: true, mode: 0o700 });

    return directory;
}

/** Never accept host paths, other identities' uploads, symlinks or invented file sizes. */
export function draftAttachments(
    app: PocketApp,
    user: User,
    agentId: string,
    value: unknown,
): Attachment[] {
    if (value === undefined) {
        return [];
    }

    if (!Array.isArray(value) || value.length > 128) {
        throw new HttpError(400, "attachments must be a list of at most 128 uploaded files");
    }

    const directory = draftUploadDirectory(app, user, agentId);

    return value.map((file) => {
        if (
            typeof file?.path !== "string" ||
            dirname(resolve(file.path)) !== directory ||
            typeof file.name !== "string" ||
            file.name.length > 120 ||
            typeof file.mime !== "string" ||
            file.mime.length > 256
        ) {
            throw new HttpError(400, "Use files uploaded for this private agent");
        }

        let stat;

        try {
            stat = lstatSync(file.path);
        } catch {
            throw new HttpError(
                400,
                "An attached upload is no longer available. Remove it and attach it again.",
            );
        }

        if (!stat.isFile() || stat.size !== file.size) {
            throw new HttpError(400, "The attached upload changed");
        }

        return { path: resolve(file.path), name: file.name, mime: file.mime, size: stat.size };
    });
}

/** Immutable copies give native transcript image routes the same conversation-local paths as ordinary uploads. */
export function materializeDraftAttachments(
    app: PocketApp,
    id: ConversationId,
    attachments: Attachment[],
): Attachment[] {
    if (attachments.length === 0) {
        return [];
    }

    const directory = app.workspace.uploadDirectory(id);

    return attachments.map((file) => {
        const path = join(directory, `draft-${basename(file.path)}`);

        try {
            copyFileSync(file.path, path, constants.COPYFILE_EXCL);
        } catch (error) {
            if ((error as NodeJS.ErrnoException).code !== "EEXIST") {
                throw error;
            }
        }

        return { ...file, path };
    });
}
