/** OpenSSH askpass child: consume one password from private FIFO IPC, never a regular file. */
import {
    closeSync,
    constants,
    fstatSync,
    openSync,
    readSync,
    writeFileSync,
    writeSync,
} from "node:fs";

function authorizedParent(path: string): number {
    const parent = process.ppid;
    const deadline = performance.now() + 250;
    const sleeper = new Int32Array(new SharedArrayBuffer(4));
    let metadata: number;

    // The Coop parent publishes the SSH PID immediately after spawn. An askpass
    // that wins that scheduling race may wait briefly, but only for ENOENT.
    while (true) {
        if (parent <= 1 || process.ppid !== parent) {
            throw new Error("SSH password parent exited.");
        }

        try {
            metadata = openSync(
                path,
                constants.O_RDONLY | constants.O_NONBLOCK | constants.O_NOFOLLOW,
            );

            break;
        } catch (error) {
            if (
                !(error instanceof Error) ||
                !("code" in error) ||
                error.code !== "ENOENT" ||
                performance.now() >= deadline
            ) {
                throw new Error("Unavailable SSH password parent.");
            }

            Atomics.wait(sleeper, 0, 0, Math.min(10, deadline - performance.now()));
        }
    }

    try {
        const info = fstatSync(metadata);

        if (
            !info.isFile() ||
            (info.mode & 0o7777) !== 0o600 ||
            (process.getuid && info.uid !== process.getuid()) ||
            info.size < 2 ||
            info.size > 11
        ) {
            throw new Error("Invalid SSH password parent record.");
        }

        const record = Buffer.alloc(12);
        const length = readSync(metadata, record, 0, record.length, 0);
        const value = record.subarray(0, length).toString("utf8");

        if (
            length > 11 ||
            !/^[1-9][0-9]{0,9}\n$/.test(value) ||
            Number(value.trim()) !== parent ||
            process.ppid !== parent
        ) {
            throw new Error("Unauthorized SSH password parent.");
        }

        return parent;
    } finally {
        closeSync(metadata);
    }
}

// Deliberately accept only ordinary login-password prompts. In particular,
// password changes, key passphrases, host-key confirmation and OTP requests
// must never receive the login password, even if the server asks repeatedly.
const prompt = process.argv[2] ?? "";
const ordinaryPassword =
    /^(?:password:|[^\s'@\x00-\x1f]+@[^\s'@\x00-\x1f]+'s password:|\([^\s'@()\x00-\x1f]+@[^\s'@()\x00-\x1f]+\) password:)[ \t]*$/i;
let fd: number | undefined;
const payload = Buffer.alloc(4097);

try {
    if (
        process.argv.length !== 3 ||
        !ordinaryPassword.test(prompt) ||
        process.env.SSH_ASKPASS_PROMPT === "confirm"
    ) {
        throw new Error("Unsupported SSH prompt.");
    }

    const fifo = process.env.PI_COOP_SSH_PASSWORD_FIFO;
    const parent = process.env.PI_COOP_SSH_PASSWORD_PARENT;
    const used = process.env.PI_COOP_SSH_PASSWORD_USED;

    if (!fifo || !parent || !used) {
        throw new Error("Missing SSH password channel.");
    }

    // ProxyJump/ProxyCommand children may inherit askpass variables. Only the
    // exact SSH process selected by Coop may consume the destination password.
    const pid = authorizedParent(parent);

    fd = openSync(fifo, constants.O_RDONLY | constants.O_NONBLOCK | constants.O_NOFOLLOW);

    const info = fstatSync(fd);

    if (
        !info.isFIFO() ||
        (info.mode & 0o777) !== 0o600 ||
        (process.getuid && info.uid !== process.getuid())
    ) {
        throw new Error("Invalid SSH password channel.");
    }

    // A second prompt gets EAGAIN/EOF instead of waiting for another password.
    // The parent writes the complete <=1025-byte record before spawning SSH.
    const length = readSync(fd, payload, 0, payload.length, null);

    if (length < 2 || length > 1025 || payload[length - 1] !== 10) {
        throw new Error("Empty or invalid SSH password channel.");
    }

    for (let i = 0; i < length - 1; i++) {
        if (payload[i] === 0 || payload[i] === 10 || payload[i] === 13) {
            throw new Error("Invalid SSH password record.");
        }
    }

    if (process.ppid !== pid) {
        throw new Error("SSH password parent exited.");
    }

    // Record only that the bound askpass consumed a valid password, never its
    // value. The Coop parent checks this marker before publishing a probe login.
    writeFileSync(used, "1\n", { flag: "wx", mode: 0o600 });

    if (process.ppid !== pid) {
        throw new Error("SSH password parent exited.");
    }

    let written = 0;

    while (written < length) {
        const count = writeSync(1, payload, written, length - written);

        if (!count) {
            throw new Error("Closed SSH password output.");
        }

        written += count;
    }
} catch {
    // OpenSSH needs only failure status. Never print IPC contents or exceptions.
    process.exitCode = 1;
} finally {
    payload.fill(0);

    if (fd !== undefined) {
        closeSync(fd);
    }
}
