/** One Pi Coop process per data directory, with cleanup bound to the acquired file generation. */
import {
    closeSync,
    constants,
    fstatSync,
    openSync,
    readFileSync,
    readSync,
    rmSync,
    writeFileSync,
} from "node:fs";

const INCOMPLETE_LOCK_GRACE_MS = 10_000;
// Node's process.kill accepts signed 32-bit pids, even on hosts with a wider number type.
const MAX_PID = 2 ** 31 - 1;

interface Lock {
    pid: number;
    fileId: string;
    mtimeMs: number;
}

interface Identity {
    version: 1;
    pid: number;
    fileId: string;
    startTime?: string;
    bootId?: string;
}

/** Read pid and generation from the same regular, no-follow descriptor. */
function openedLock(fd: number): Lock {
    const stat = fstatSync(fd, { bigint: true });

    if (!stat.isFile()) {
        throw new Error("Pi Coop's data-directory lock is not a regular file.");
    }

    const bytes = Buffer.alloc(1024);
    const length = readSync(fd, bytes, 0, bytes.length, 0);

    return {
        pid:
            stat.size > BigInt(bytes.length)
                ? NaN
                : Number(bytes.toString("utf8", 0, length).trim()),
        fileId: `${stat.dev}:${stat.ino}:${stat.ctimeNs}`,
        mtimeMs: Number(stat.mtimeMs),
    };
}

function readLock(lockFile: string): Lock | undefined {
    let fd: number;

    try {
        fd = openSync(lockFile, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
    } catch (error) {
        if ((error as NodeJS.ErrnoException).code === "ENOENT") {
            return undefined;
        }

        throw error;
    }

    try {
        return openedLock(fd);
    } finally {
        closeSync(fd);
    }
}

/** Linux comm may contain spaces and parentheses; fields after its final ')' start at field 3. */
function processIdentity(pid: number): Pick<Identity, "startTime" | "bootId"> {
    const identity: Pick<Identity, "startTime" | "bootId"> = {};

    try {
        const stat = readFileSync(`/proc/${pid}/stat`, "utf8");
        const end = stat.lastIndexOf(")");
        const start =
            end === -1
                ? undefined
                : stat
                      .slice(end + 2)
                      .trim()
                      .split(/\s+/)[19];

        if (start !== undefined && /^\d+$/.test(start)) {
            identity.startTime = start;
        }
    } catch {
        // Missing process evidence cannot establish that a live holder is stale.
    }

    try {
        const boot = readFileSync("/proc/sys/kernel/random/boot_id", "utf8").trim();

        if (/^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i.test(boot)) {
            identity.bootId = boot;
        }
    } catch {
        // Non-Linux hosts retain the conservative live-pid fallback.
    }

    return identity;
}

function readIdentity(lockFile: string, lock: Lock): Identity | undefined {
    let fd: number | undefined;

    try {
        fd = openSync(
            `${lockFile}.identity`,
            constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK,
        );
        const stat = fstatSync(fd);

        if (!stat.isFile() || stat.size > 4096) {
            return undefined;
        }

        const bytes = Buffer.alloc(4096);
        const length = readSync(fd, bytes, 0, bytes.length, 0);
        const value = JSON.parse(bytes.toString("utf8", 0, length)) as Identity;

        if (
            value?.version === 1 &&
            value.pid === lock.pid &&
            value.fileId === lock.fileId &&
            (value.startTime === undefined ||
                (typeof value.startTime === "string" && /^\d+$/.test(value.startTime))) &&
            (value.bootId === undefined ||
                (typeof value.bootId === "string" &&
                    /^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i.test(value.bootId)))
        ) {
            return value;
        }
    } catch {
        // Damaged, missing or old metadata never authorizes takeover of a live pid.
    } finally {
        if (fd !== undefined) {
            closeSync(fd);
        }
    }

    return undefined;
}

function lockHolder(lockFile: string, lock: Lock): boolean {
    if (!Number.isSafeInteger(lock.pid) || lock.pid <= 0 || lock.pid > MAX_PID) {
        if (Date.now() - lock.mtimeMs < INCOMPLETE_LOCK_GRACE_MS) {
            throw new Error(
                `Pi Coop's lock is incomplete or damaged and still recent: ${lockFile}. Try again shortly.`,
            );
        }

        return false;
    }

    try {
        process.kill(lock.pid, 0);
    } catch (error) {
        // EPERM and unknown failures are not evidence that a holder has stopped.
        return (error as NodeJS.ErrnoException).code !== "ESRCH";
    }

    const saved = readIdentity(lockFile, lock);
    const current = processIdentity(lock.pid);

    if (
        saved !== undefined &&
        ((saved.startTime !== undefined &&
            current.startTime !== undefined &&
            saved.startTime !== current.startTime) ||
            (saved.bootId !== undefined &&
                current.bootId !== undefined &&
                saved.bootId !== current.bootId))
    ) {
        return false;
    }

    // Executable names and wall-clock estimates do not identify a process generation.
    return true;
}

function matches(current: Lock | undefined, owned: Lock): boolean {
    return (
        current !== undefined &&
        Object.is(current.pid, owned.pid) &&
        current.fileId === owned.fileId
    );
}

/** Generation checks are best-effort, not an atomic OS compare-and-unlink or a distributed lease. */
function release(lockFile: string, owned: Lock): void {
    if (!matches(readLock(lockFile), owned)) {
        return;
    }

    if (readIdentity(lockFile, owned) !== undefined) {
        rmSync(`${lockFile}.identity`, { force: true });
    }

    if (matches(readLock(lockFile), owned)) {
        rmSync(lockFile, { force: true });
    }
}

/** Keep the pid-only format for older readers; return cleanup for this acquisition alone. */
export function takeLock(lockFile: string): () => void {
    const previous = readLock(lockFile);

    if (previous !== undefined) {
        if (lockHolder(lockFile, previous)) {
            throw new Error(
                `Pi Coop is already running on this data directory (pid ${previous.pid}). Stop that holder before trying again.`,
            );
        }

        release(lockFile, previous);
    }

    let fd: number;

    try {
        fd = openSync(lockFile, "wx+", 0o600);
    } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "EEXIST") {
            throw error;
        }

        throw new Error(
            "Pi Coop is already running on this data directory: another one started at the same moment.",
        );
    }

    let owned: Lock;

    try {
        writeFileSync(fd, `${process.pid}\n`);
        owned = openedLock(fd);
    } finally {
        closeSync(fd);
    }

    try {
        const identity: Identity = {
            version: 1,
            pid: owned.pid,
            fileId: owned.fileId,
            ...processIdentity(process.pid),
        };

        // An unbound orphan remains inert rather than overwriting another generation's metadata.
        try {
            writeFileSync(`${lockFile}.identity`, `${JSON.stringify(identity)}\n`, {
                flag: "wx",
                mode: 0o600,
            });
        } catch (error) {
            if ((error as NodeJS.ErrnoException).code !== "EEXIST") {
                throw error;
            }
        }

        if (!matches(readLock(lockFile), owned)) {
            throw new Error("Pi Coop's data-directory lock changed during acquisition.");
        }
    } catch (error) {
        release(lockFile, owned);

        throw error;
    }

    return () => release(lockFile, owned);
}
