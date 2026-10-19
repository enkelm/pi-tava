/** Ephemeral SSH passwords: memory-only credentials and one-use, per-process askpass FIFOs. */
import { execFile } from "node:child_process";
import { constants, linkSync, unlinkSync, writeFileSync } from "node:fs";
import { chmod, mkdtemp, open, rm, writeFile, type FileHandle } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

const run = promisify(execFile);
const ASKPASS = fileURLToPath(new URL("./ssh-askpass.ts", import.meta.url));
const IDLE_TTL = 30 * 60 * 1000;
const ABSOLUTE_TTL = 8 * 60 * 60 * 1000;
const MAX_ENTRIES = 32;
const quote = (value: string) => `'${value.replaceAll("'", "'\\''")}'`;

export interface SshPasswordLease {
    /** Overrides only. Merge with the SSH child's base environment, never persist. */
    env: NodeJS.ProcessEnv;
    /** Bind once to the SSH child's PID, synchronously immediately after spawn. */
    authorize(pid: number): void;
    /** Call on spawn failure, cancellation and child close. Idempotent. */
    close(): Promise<void>;
}

export interface SshPasswordCredential {
    /** A fresh one-use password channel for one SSH child; never share a lease. */
    prepare(): Promise<SshPasswordLease>;
    /** Whether a closed lease's bound askpass actually consumed this password. */
    wasPrompted(): boolean;
    /** Immediately revoke and wipe this credential, and clean up its active channels. */
    dispose(): void;
}

class PasswordCredential implements SshPasswordCredential {
    #password: Buffer;
    #disposed = false;
    #wasPrompted = false;
    #leases = new Set<SshPasswordLease>();

    constructor(password: string) {
        if (
            typeof password !== "string" ||
            !password.length ||
            /[\0\r\n]/.test(password) ||
            Buffer.byteLength(password, "utf8") > 1024
        ) {
            throw new Error("SSH password must be 1–1024 UTF-8 bytes without NUL or line breaks.");
        }

        this.#password = Buffer.from(password, "utf8");
    }

    #requireActive() {
        if (this.#disposed) {
            throw new Error("SSH password is no longer available. Sign in again.");
        }
    }

    async prepare(): Promise<SshPasswordLease> {
        this.#requireActive();

        const directory = await mkdtemp(join(tmpdir(), "coop-ssh-password-"));
        const fifo = join(directory, "password");
        const wrapper = join(directory, "askpass");
        const parent = join(directory, "parent");
        const used = join(directory, "used");
        let handle: FileHandle | undefined;
        let closing: Promise<void> | undefined;
        const lease: SshPasswordLease = {
            env: {
                SSH_ASKPASS: wrapper,
                SSH_ASKPASS_REQUIRE: "force",
                DISPLAY: "pi-coop-askpass",
                PI_COOP_SSH_PASSWORD_FIFO: fifo,
                PI_COOP_SSH_PASSWORD_PARENT: parent,
                PI_COOP_SSH_PASSWORD_USED: used,
            },
            authorize: (pid) => {
                this.#requireActive();

                if (closing || !Number.isSafeInteger(pid) || pid <= 1 || pid > 0x7fffffff) {
                    throw new Error("Cannot authorize SSH password parent process.");
                }

                // Publish a complete public PID record, never password data.
                // Exclusive linking prevents rebinding, and avoids an askpass
                // observing the empty file between open and write.
                const pending = `${parent}.pending`;

                writeFileSync(pending, `${pid}\n`, { flag: "wx", mode: 0o600 });

                try {
                    linkSync(pending, parent);
                } finally {
                    unlinkSync(pending);
                }
            },
            close: () => {
                this.#leases.delete(lease);
                closing ??= (async () => {
                    try {
                        try {
                            const marker = await open(
                                used,
                                constants.O_RDONLY | constants.O_NONBLOCK | constants.O_NOFOLLOW,
                            );

                            try {
                                const info = await marker.stat();

                                if (
                                    info.isFile() &&
                                    (info.mode & 0o7777) === 0o600 &&
                                    (!process.getuid || info.uid === process.getuid()) &&
                                    info.size === 2
                                ) {
                                    const record = Buffer.alloc(3);
                                    const { bytesRead } = await marker.read(record, 0, 3, 0);

                                    if (bytesRead === 2 && record[0] === 49 && record[1] === 10) {
                                        this.#wasPrompted = true;
                                    }
                                }
                            } finally {
                                await marker.close();
                            }
                        } catch {
                            // Missing, malformed or inaccessible markers never prove a prompt.
                        }

                        await handle?.close();
                    } finally {
                        await rm(directory, { recursive: true, force: true });
                    }
                })();

                return closing;
            },
        };

        try {
            this.#requireActive();
            await chmod(directory, 0o700);
            await run("/usr/bin/mkfifo", ["-m", "600", fifo], { timeout: 5000 });
            this.#requireActive();
            handle = await open(
                fifo,
                constants.O_RDWR | constants.O_NONBLOCK | constants.O_NOFOLLOW,
            );

            const info = await handle.stat();

            if (!info.isFIFO() || (info.mode & 0o777) !== 0o600) {
                throw new Error("Cannot create private SSH password channel.");
            }

            await writeFile(
                wrapper,
                `#!/bin/sh\nexec ${quote(process.execPath)} ${quote(ASKPASS)} "$@"\n`,
                { mode: 0o700, flag: "wx" },
            );
            this.#requireActive();

            // Preload the empty, single-writer FIFO and check the entire bounded
            // record was written. The regular wrapper never contains the password.
            const payload = Buffer.alloc(this.#password.length + 1);

            try {
                this.#password.copy(payload);
                payload[payload.length - 1] = 10;

                const { bytesWritten } = await handle.write(payload, 0, payload.length, null);

                if (bytesWritten !== payload.length) {
                    throw new Error("Cannot prepare SSH password channel.");
                }
            } finally {
                payload.fill(0);
            }

            this.#requireActive();
            this.#leases.add(lease);

            return lease;
        } catch {
            await lease.close();

            // Child-process errors must not acquire password-bearing context.
            throw new Error("Cannot prepare SSH password login. Sign in again.");
        }
    }

    wasPrompted(): boolean {
        return this.#wasPrompted;
    }

    dispose(): void {
        if (this.#disposed) {
            return;
        }

        this.#disposed = true;
        this.#password.fill(0);

        for (const lease of this.#leases) {
            void lease.close().catch(() => {});
        }
    }
}

/** Create a probe credential first; publish it only after successful SSH authentication. */
export function createSshPassword(password: string): SshPasswordCredential {
    return new PasswordCredential(password);
}

type Entry = {
    userId: string;
    credential: SshPasswordCredential;
    createdAt: number;
    expiresAt: number;
    timer: ReturnType<typeof setTimeout>;
};

/** Per-person, exact-destination login cache. Nothing here is durable or serializable. */
export class SshPasswords {
    #entries = new Map<string, Entry>();
    #closed = false;

    #key(userId: string, host: string) {
        return JSON.stringify([userId, host]);
    }

    #remove(key: string) {
        const entry = this.#entries.get(key);

        if (entry) {
            this.#entries.delete(key);
            clearTimeout(entry.timer);
            entry.credential.dispose();
        }
    }

    #schedule(key: string, credential: SshPasswordCredential, userId: string, createdAt: number) {
        const expiresAt = Math.min(Date.now() + IDLE_TTL, createdAt + ABSOLUTE_TTL);
        const timer = setTimeout(() => this.#remove(key), Math.max(0, expiresAt - Date.now()));

        timer.unref();
        this.#entries.set(key, { userId, credential, createdAt, expiresAt, timer });
    }

    set(
        userId: string,
        host: string,
        password: string | SshPasswordCredential,
    ): SshPasswordCredential {
        if (this.#closed) {
            if (typeof password !== "string") {
                password.dispose();
            }

            throw new Error("SSH password logins are closed.");
        }

        const credential = typeof password === "string" ? createSshPassword(password) : password;
        const key = this.#key(userId, host);
        const previous = this.#entries.get(key);

        if (previous?.credential === credential) {
            this.get(userId, host);

            return credential;
        }

        this.#remove(key);

        while (this.#entries.size >= MAX_ENTRIES) {
            this.#remove(this.#entries.keys().next().value!);
        }

        this.#schedule(key, credential, userId, Date.now());

        return credential;
    }

    get(userId: string, host: string): SshPasswordCredential | undefined {
        const key = this.#key(userId, host);
        const entry = this.#entries.get(key);

        if (!entry) {
            return undefined;
        }

        if (entry.expiresAt <= Date.now()) {
            this.#remove(key);

            return undefined;
        }

        clearTimeout(entry.timer);
        this.#entries.delete(key);
        this.#schedule(key, entry.credential, entry.userId, entry.createdAt);

        return entry.credential;
    }

    status(
        userId: string,
        host: string,
    ): { authenticated: boolean; expiresAt?: number; expiresInMs?: number } {
        const key = this.#key(userId, host);
        const entry = this.#entries.get(key);

        if (!entry) {
            return { authenticated: false };
        }

        if (entry.expiresAt <= Date.now()) {
            this.#remove(key);

            return { authenticated: false };
        }

        return {
            authenticated: true,
            expiresAt: entry.expiresAt,
            expiresInMs: Math.max(0, entry.expiresAt - Date.now()),
        };
    }

    forget(userId: string, host: string): void {
        this.#remove(this.#key(userId, host));
    }

    forgetUser(userId: string): void {
        for (const [key, entry] of this.#entries) {
            if (entry.userId === userId) {
                this.#remove(key);
            }
        }
    }

    close(): void {
        this.#closed = true;

        for (const key of this.#entries.keys()) {
            this.#remove(key);
        }
    }
}
