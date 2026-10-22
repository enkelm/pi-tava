/** Shared attachment streaming; callers authorize and choose the exact private staging directory. */
import { randomUUID } from "node:crypto";
import { createWriteStream, rmSync } from "node:fs";
import type { IncomingMessage } from "node:http";
import { basename, extname, join } from "node:path";
import { pipeline } from "node:stream/promises";
import type { Attachment } from "../commands.ts";
import { HttpError } from "../errors.ts";
import { TYPES } from "./assets.ts";

const MAX_UPLOAD = 50 * 1024 * 1024;

export async function receiveUpload(
    request: IncomingMessage,
    directory: string,
    requestedName: string,
): Promise<Attachment> {
    if (Number(request.headers["content-length"] ?? 0) > MAX_UPLOAD) {
        throw new HttpError(413, "Files can be up to 50 MB");
    }

    const base = basename(requestedName)
        .replace(/[^\w.\- ()]+/g, "_")
        .trim();
    const name = base === "" || base.startsWith(".") ? `upload${base}` : base.slice(0, 120);
    const file = join(directory, `${Date.now().toString(36)}-${randomUUID().slice(0, 8)}-${name}`);
    let size = 0;

    request.on("data", (chunk: Buffer) => {
        size += chunk.length;

        if (size > MAX_UPLOAD) {
            request.destroy(new HttpError(413, "Files can be up to 50 MB"));
        }
    });

    try {
        await pipeline(request, createWriteStream(file, { mode: 0o600, flags: "wx" }));
    } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "EEXIST") {
            rmSync(file, { force: true });
        }

        if (error instanceof HttpError || request.complete) {
            throw error;
        }

        throw new HttpError(400, "The upload stopped before it finished");
    }

    const mime =
        String(request.headers["content-type"] ?? "") ||
        TYPES[extname(name).toLowerCase()] ||
        "application/octet-stream";

    return { path: file, name, mime: mime.split(";")[0]!.trim(), size };
}
