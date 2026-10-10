/** Byte-exact revisions and bounded, conflict-checked atomic saves of existing text files. */
import { createHash, randomUUID } from "node:crypto";
import {
    constants,
    fstatSync,
    lstatSync,
    readSync,
    realpathSync,
    renameSync,
    statSync,
    unlinkSync,
    type Stats,
} from "node:fs";
import { open, type FileHandle } from "node:fs/promises";
import { dirname, join } from "node:path";
import { describe, HttpError } from "./errors.ts";

export const MAX_EDIT_BYTES = 512 * 1024;

/** The revision represents exact bytes, including a BOM and every newline. */
export function textRevision(bytes: Uint8Array): string {
    return createHash("sha256").update(bytes).digest("hex");
}

/** Buffer decoding preserves a BOM. Round-tripping rejects malformed UTF-8 without replacing bytes. */
export function decodeText(bytes: Buffer): string | undefined {
    const text = bytes.toString("utf8");

    return !bytes.includes(0) && Buffer.from(text, "utf8").equals(bytes) ? text : undefined;
}

/** Read through EOF or one byte beyond the edit cap, even when a filesystem returns short reads. */
export async function boundedBytes(handle: FileHandle): Promise<Buffer> {
    const buffer = Buffer.alloc(MAX_EDIT_BYTES + 1);
    let length = 0;

    while (length < buffer.length) {
        const { bytesRead } = await handle.read(buffer, length, buffer.length - length, length);

        if (bytesRead === 0) {
            break;
        }

        length += bytesRead;
    }

    return buffer.subarray(0, length);
}

export function fileEditInput(
    path: unknown,
    text: unknown,
    revision: unknown,
): { path: string; bytes: Buffer; revision: string } {
    if (typeof path !== "string" || path.trim() === "" || path.includes("\0")) {
        throw new HttpError(400, "Name the file to save.");
    }

    if (typeof text !== "string") {
        throw new HttpError(400, "text must be text");
    }

    if (typeof revision !== "string" || !/^[a-f0-9]{64}$/.test(revision)) {
        throw new HttpError(400, "Give the file's revision from a complete text view.");
    }

    // Count before allocating; JSON can contain lone surrogates, which UTF-8 cannot represent exactly.
    if (Buffer.byteLength(text, "utf8") > MAX_EDIT_BYTES) {
        throw new HttpError(413, "Text files may be at most 512 KiB.");
    }

    const bytes = Buffer.from(text, "utf8");

    if (decodeText(bytes) !== text) {
        throw new HttpError(400, "Text must be valid UTF-8 without NUL characters.");
    }

    return { path, bytes, revision };
}

const pending = new Map<string, Promise<void>>();
const READ_FLAGS = constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK;

function conflict(): HttpError {
    return new HttpError(
        409,
        "The file changed or cannot be edited safely. Reload it before saving.",
    );
}

function sameFile(a: Stats, b: Stats): boolean {
    return a.dev === b.dev && a.ino === b.ino;
}

function unchanged(a: Stats, b: Stats): boolean {
    return (
        sameFile(a, b) &&
        a.size === b.size &&
        a.mtimeMs === b.mtimeMs &&
        a.ctimeMs === b.ctimeMs &&
        a.mode === b.mode &&
        a.nlink === b.nlink &&
        a.uid === b.uid &&
        a.gid === b.gid
    );
}

function editable(info: Stats): boolean {
    // Atomic replacement would split a hardlink from its siblings; refuse that ambiguity.
    return info.isFile() && info.nlink === 1 && info.size <= MAX_EDIT_BYTES;
}

function currentBytes(fd: number): Buffer {
    const buffer = Buffer.alloc(MAX_EDIT_BYTES + 1);
    let length = 0;

    while (length < buffer.length) {
        const count = readSync(fd, buffer, length, buffer.length - length, length);

        if (count === 0) {
            break;
        }

        length += count;
    }

    return buffer.subarray(0, length);
}

/**
 * `authorize` resolves the original request again and checks live access, driver, busy and protected-path rules.
 * Saves across conversations and aliases share the canonical-path queue. External programs remain outside it.
 */
export async function saveFileEdit(
    input: { bytes: Buffer; revision: string },
    authorize: () => Promise<string>,
): Promise<{ revision: string }> {
    const file = await authorize();
    const previous = pending.get(file) ?? Promise.resolve();
    let release!: () => void;
    const held = new Promise<void>((resolve) => {
        release = resolve;
    });
    const tail = previous.then(() => held);

    pending.set(file, tail);
    await previous;

    try {
        return await replaceFile(file, input, authorize);
    } finally {
        release();

        if (pending.get(file) === tail) {
            pending.delete(file);
        }
    }
}

async function replaceFile(
    file: string,
    input: { bytes: Buffer; revision: string },
    authorize: () => Promise<string>,
): Promise<{ revision: string }> {
    let original: FileHandle | undefined;
    let temporary: FileHandle | undefined;
    let temporaryPath: string | undefined;
    let temporaryInfo: Stats | undefined;
    const parent = dirname(file);
    const result = { revision: textRevision(input.bytes) };
    let parentInfo: Stats | undefined;

    try {
        if ((await authorize()) !== file) {
            throw conflict();
        }

        parentInfo = statSync(parent);
        const named = lstatSync(file);

        if (!editable(named) || realpathSync(parent) !== parent) {
            throw conflict();
        }

        original = await open(file, READ_FLAGS);
        const before = await original.stat();

        if (!editable(before) || !unchanged(named, before)) {
            throw conflict();
        }

        const bytes = await boundedBytes(original);

        if (
            bytes.length > MAX_EDIT_BYTES ||
            decodeText(bytes) === undefined ||
            textRevision(bytes) !== input.revision ||
            !unchanged(before, await original.stat())
        ) {
            throw conflict();
        }

        const candidate = join(parent, `.pi-edit-${randomUUID()}.tmp`);

        temporary = await open(
            candidate,
            constants.O_RDWR | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW,
            0o600,
        );
        temporaryPath = candidate;
        temporaryInfo = await temporary.stat();
        await temporary.writeFile(input.bytes);

        if (temporaryInfo.uid !== before.uid || temporaryInfo.gid !== before.gid) {
            await temporary.chown(before.uid, before.gid);
        }

        await temporary.chmod(before.mode & 0o7777);
        await temporary.sync();

        if ((await authorize()) !== file) {
            throw conflict();
        }

        // No JS yield between final path/inode/hash checks and rename. Node has no portable renameat or
        // compare-and-swap rename: an external process can still race this final OS boundary (best effort).
        const now = fstatSync(original.fd);
        const current = currentBytes(original.fd);
        const replacement = fstatSync(temporary.fd);

        if (
            !editable(replacement) ||
            replacement.mode !== before.mode ||
            !sameFile(temporaryInfo, replacement) ||
            !currentBytes(temporary.fd).equals(input.bytes) ||
            !unchanged(replacement, fstatSync(temporary.fd)) ||
            !unchanged(replacement, lstatSync(temporaryPath)) ||
            !unchanged(before, now) ||
            textRevision(current) !== input.revision ||
            decodeText(current) === undefined ||
            !unchanged(now, fstatSync(original.fd)) ||
            !unchanged(before, lstatSync(file)) ||
            realpathSync(file) !== file ||
            realpathSync(parent) !== parent ||
            !sameFile(parentInfo, statSync(parent))
        ) {
            throw conflict();
        }

        renameSync(temporaryPath, file);
        temporaryPath = undefined;

        return result;
    } catch (error) {
        if (error instanceof HttpError) {
            throw error;
        }

        throw new HttpError(409, `Could not save the file: ${describe(error)}`);
    } finally {
        // Once renamed, cleanup failures must never turn a successful write into a reported failure.
        await original?.close().catch(() => {});
        await temporary?.close().catch(() => {});

        if (
            temporaryPath !== undefined &&
            parentInfo !== undefined &&
            temporaryInfo !== undefined
        ) {
            try {
                if (
                    realpathSync(parent) === parent &&
                    sameFile(parentInfo, statSync(parent)) &&
                    sameFile(temporaryInfo, lstatSync(temporaryPath))
                ) {
                    unlinkSync(temporaryPath);
                }
            } catch {
                // Best-effort cleanup only; never follow a swapped parent to remove an unrelated file.
            }
        }
    }
}
