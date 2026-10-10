/** Opaque, pane-scoped private files. Admission promotes files out of expiring staging before external input. */
import { randomUUID } from "node:crypto";
import { constants } from "node:fs";
import { chmod, lstat, mkdir, open, readdir, rename, rm } from "node:fs/promises";
import type { IncomingMessage } from "node:http";
import { join, resolve } from "node:path";
import { HttpError } from "../errors.ts";

const MAX_FILE = 50 * 1024 * 1024;
const MAX_PENDING = 100;
const UPLOAD_TIMEOUT = 60_000;
const PENDING_TIMEOUT = 60 * 60_000;

export const MAX_ATTACHMENTS = 10;

export type UploadScope = { user: string; pane: string; revision: string };
type Upload = UploadScope & {
    id: string;
    name: string;
    size: number;
    directory: string;
    retainedDirectory: string;
    state: "streaming" | "ready" | "retained";
    timer?: ReturnType<typeof setTimeout>;
};

export const uploadId = (value: unknown): value is string =>
    typeof value === "string" &&
    /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/.test(value);

function safeName(value: unknown): string {
    if (typeof value !== "string" || !value || value.length > 4096) {
        throw new HttpError(400, "Name the file to upload");
    }

    // A display name is never a path. Strip both POSIX and Windows separators and use ASCII only.
    const leaf = value.split(/[\\/]/).at(-1) ?? "";
    const name = leaf
        .replace(/[^a-zA-Z0-9._-]/g, "_")
        .replace(/^\.+/, "")
        .slice(-120);

    return name && !/^\.+$/.test(name) ? name : "attachment";
}

/** Called only after PrivateSessions checks the live owner and verified idle pane.
 * The registry is intentionally memory-only: restarts invalidate tokens and never replay submissions.
 * Retained files have no automatic deletion path, even if admission or delivery later fails.
 */
export class PrivateUploads {
    readonly #dataDir: () => string;
    readonly #epoch = randomUUID();
    readonly #uploads = new Map<string, Upload>();
    #ready?: Promise<void>;

    constructor(dataDir: () => string) {
        this.#dataDir = dataDir;
    }

    get #root(): string {
        return resolve(this.#dataDir(), "private-uploads");
    }

    async #prepare(): Promise<void> {
        for (const directory of [
            this.#root,
            join(this.#root, "pending"),
            join(this.#root, "retained"),
            join(this.#root, "pending", this.#epoch),
        ]) {
            await mkdir(directory, { mode: 0o700 }).catch((error: NodeJS.ErrnoException) => {
                if (error.code !== "EEXIST") {
                    throw error;
                }
            });
            const metadata = await lstat(directory);

            if (!metadata.isDirectory() || metadata.isSymbolicLink()) {
                throw new HttpError(409, "Private upload storage is not a regular directory");
            }

            await chmod(directory, 0o700);
        }

        // The app's data-directory lock excludes a previous server. Only staging from old
        // epochs is disposable: every admitted prompt has already promoted all its files.
        const pending = join(this.#root, "pending");

        for (const entry of await readdir(pending, { withFileTypes: true })) {
            if (entry.isDirectory() && uploadId(entry.name) && entry.name !== this.#epoch) {
                await rm(join(pending, entry.name), { recursive: true, force: true });
            }
        }
    }

    async #discard(upload: Upload): Promise<void> {
        if (upload.state === "retained") {
            return;
        }

        clearTimeout(upload.timer);
        this.#uploads.delete(upload.id);
        await rm(upload.directory, { recursive: true, force: true });
    }

    async store(
        scope: UploadScope,
        name: unknown,
        request: IncomingMessage,
        verify: () => Promise<void>,
    ): Promise<{ id: string; name: string; size: number }> {
        const filename = safeName(name);

        if (Number(request.headers["content-length"] ?? 0) > MAX_FILE) {
            throw new HttpError(413, "Private attachments are limited to 50 MiB each");
        }

        const pending = [...this.#uploads.values()].filter((item) => item.state !== "retained");

        if (
            pending.length >= MAX_PENDING ||
            pending.filter((item) => item.user === scope.user && item.pane === scope.pane).length >=
                MAX_ATTACHMENTS
        ) {
            throw new HttpError(429, "Too many unsubmitted private attachments; remove some first");
        }

        const id = randomUUID();
        const upload: Upload = {
            ...scope,
            id,
            name: filename,
            size: 0,
            directory: join(this.#root, "pending", this.#epoch, id),
            retainedDirectory: join(this.#root, "retained", id),
            state: "streaming",
        };

        this.#uploads.set(id, upload);
        const timer = setTimeout(
            () => request.destroy(new HttpError(408, "The private upload took too long")),
            UPLOAD_TIMEOUT,
        );
        let file: Awaited<ReturnType<typeof open>> | undefined;

        try {
            this.#ready ??= this.#prepare();
            await this.#ready;
            await mkdir(upload.directory, { mode: 0o700 });
            file = await open(
                join(upload.directory, upload.name),
                constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW,
                0o600,
            );

            for await (const chunk of request) {
                const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);

                upload.size += bytes.length;

                if (upload.size > MAX_FILE) {
                    throw new HttpError(413, "Private attachments are limited to 50 MiB each");
                }

                // Descriptor writes can be partial; never acknowledge bytes that were not saved.
                let offset = 0;

                while (offset < bytes.length) {
                    const { bytesWritten } = await file.write(bytes, offset, bytes.length - offset);

                    if (!bytesWritten) {
                        throw new Error("Private upload write made no progress");
                    }

                    offset += bytesWritten;
                }
            }

            if (!request.complete || request.aborted) {
                throw new HttpError(400, "The private upload was aborted");
            }

            await file.close();
            file = undefined;
            clearTimeout(timer);
            await verify();
            upload.state = "ready";
            upload.timer = setTimeout(() => {
                void this.#discard(upload).catch(() => {});
            }, PENDING_TIMEOUT);
            upload.timer.unref();

            return { id, name: upload.name, size: upload.size };
        } catch (error) {
            await file?.close().catch(() => {});
            await this.#discard(upload);

            if (!(error instanceof HttpError) && request.aborted) {
                throw new HttpError(400, "The private upload was aborted");
            }

            throw error;
        } finally {
            clearTimeout(timer);
        }
    }

    #selected(scope: UploadScope, ids: string[]): Upload[] {
        return ids.map((id) => {
            const item = this.#uploads.get(id);

            if (
                !item ||
                item.user !== scope.user ||
                item.pane !== scope.pane ||
                item.revision !== scope.revision ||
                item.state !== "ready"
            ) {
                throw new HttpError(
                    409,
                    "This attachment is unavailable for the current private pane",
                );
            }

            return item;
        });
    }

    paths(scope: UploadScope, ids: string[]): string[] {
        return this.#selected(scope, ids).map((item) => join(item.retainedDirectory, item.name));
    }

    /** Protect all files synchronously before promotion or a durable admission attempt can yield.
     * DELETE and expiry cannot race this transition. Failed admission is conservatively retained too.
     */
    async retain(scope: UploadScope, ids: string[]): Promise<void> {
        const selected = this.#selected(scope, ids);

        for (const item of selected) {
            item.state = "retained";
            clearTimeout(item.timer);
        }

        for (const item of selected) {
            await rename(item.directory, item.retainedDirectory);
        }
    }

    async remove(user: string, pane: string, id: unknown): Promise<{ ok: true }> {
        if (!uploadId(id)) {
            throw new HttpError(400, "Select an attachment token, not a path");
        }

        const item = this.#uploads.get(id);

        if (!item || item.user !== user || item.pane !== pane) {
            throw new HttpError(404, "Private attachment not found");
        }

        if (item.state !== "ready") {
            throw new HttpError(409, "Only unsubmitted attachments can be removed");
        }

        await this.#discard(item);

        return { ok: true };
    }
}
