/** OpenSSH transport only. Workflow authorization belongs to the caller, never to this backend. */
import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { AsyncLocalStorage } from "node:async_hooks";
import { BACKGROUND_CONTEXT, withAbortSignal } from "@earendil-works/chord/context";
import { posix } from "node:path";
import { randomUUID, createHash } from "node:crypto";
import { StringDecoder } from "node:string_decoder";
import { sandboxProfile } from "./workflow-shell.ts";
import type { SshPasswordCredential, SshPasswordLease } from "./ssh-passwords.ts";
import type { Context } from "@earendil-works/chord";
import {
    FileError,
    getOrThrow,
    ExecutionError,
    LineScanner,
    ok,
    err,
    type ExecutionEnv,
    type Result,
    type FileInfo,
    type BinaryReader,
    type DirReader,
    type TextLineReader,
    type FileWatcher,
    type WatchTarget,
    type WatchChange,
    type ShellExecOptions,
    type ShellExecResult,
} from "@earendil-works/pi-durable/env";

const CHUNK = 32 * 1024;
const MAX_READ = 32 * 1024 * 1024;
const MAX_PACKET = 1024 * 1024;
const q = (value: string) => `'${value.replaceAll("'", "'\\''")}'`;

const u32 = (n: number) => {
    const b = Buffer.alloc(4);

    b.writeUInt32BE(n);

    return b;
};

const u64 = (n: number) => {
    const b = Buffer.alloc(8);

    b.writeBigUInt64BE(BigInt(n));

    return b;
};

const str = (s: string | Uint8Array) => {
    const b = Buffer.from(s);

    return Buffer.concat([u32(b.length), b]);
};

/** Restrict destinations, not shell expressions or ssh options. Config aliases retain native resolution. */
export function validateSshHost(host: string): string {
    // OpenSSH accepts ssh://[user@]hostname[:port] natively. Keep that URI intact
    // through commands and SFTP so saved nonstandard ports are never discarded.
    const address = host.startsWith("ssh://") ? host.slice(6) : host;
    const port = host.startsWith("ssh://") ? /^(.*):([0-9]+)$/.exec(address) : null;
    const target = port?.[1] ?? address;

    if (
        !/^(?:[A-Za-z0-9_][A-Za-z0-9_.-]*@)?(?:[A-Za-z0-9_][A-Za-z0-9_.-]*|\[[A-Fa-f0-9:]+\])$/.test(
            target,
        ) ||
        (port !== null && (Number(port[2]) < 1 || Number(port[2]) > 65535)) ||
        host.length > 255
    ) {
        throw new Error(
            "Use an SSH config alias, user@host or ssh://[user@]host:port, without passwords, options or shell syntax.",
        );
    }

    return host;
}

function args(host: string, password = false): string[] {
    return [
        "-T",
        password ? "-oBatchMode=no" : "-oBatchMode=yes",
        ...(password
            ? [
                  "-oStrictHostKeyChecking=yes",
                  "-oControlPath=none",
                  "-oControlMaster=no",
                  "-oControlPersist=no",
                  "-oPreferredAuthentications=password,keyboard-interactive",
                  "-oPubkeyAuthentication=no",
                  "-oPasswordAuthentication=yes",
                  "-oKbdInteractiveAuthentication=yes",
                  "-oNumberOfPasswordPrompts=1",
              ]
            : []),
        "-oForwardAgent=no",
        "-oClearAllForwardings=yes",
        "-oPermitLocalCommand=no",
        "-oSendEnv=-*",
        "-oConnectTimeout=15",
        host,
    ];
}

class Cursor {
    data: Buffer;
    offset = 0;
    constructor(data: Buffer) {
        this.data = data;
    }
    uint() {
        const n = this.data.readUInt32BE(this.offset);

        this.offset += 4;

        return n;
    }
    bytes() {
        const n = this.uint();
        const b = this.data.subarray(this.offset, this.offset + n);

        this.offset += n;

        if (b.length !== n) {
            throw new Error("Truncated SFTP packet");
        }

        return b;
    }
    text() {
        return this.bytes().toString("utf8");
    }
    attrs(path: string, withMode = false): FileInfo & { mode?: number } {
        const flags = this.uint();
        let size = 0;
        let permissions = 0;
        let mtimeMs = 0;

        if (flags & 1) {
            size = Number(this.data.readBigUInt64BE(this.offset));
            this.offset += 8;
        }

        if (flags & 2) {
            this.offset += 8;
        }

        if (flags & 4) {
            permissions = this.uint();
        }

        if (flags & 8) {
            this.uint();
            mtimeMs = this.uint() * 1000;
        }

        if (flags & 0x80000000) {
            const count = this.uint();

            for (let i = 0; i < count; i++) {
                this.bytes();
                this.bytes();
            }
        }

        const kind = permissions & 0xf000;

        if (![0x8000, 0x4000, 0xa000].includes(kind)) {
            throw new FileError("not_supported", "Unsupported remote file kind", path);
        }

        return {
            path,
            name: posix.basename(path),
            kind: kind === 0x4000 ? "directory" : kind === 0xa000 ? "symlink" : "file",
            size,
            mtimeMs,
            ...(withMode && flags & 4 ? { mode: permissions } : {}),
        };
    }
}

/** One bounded, sequential SFTP v3 connection. No shell encoding of paths or file bytes. */
class Sftp {
    child: ChildProcessWithoutNullStreams;
    buffer = Buffer.alloc(0);
    failure?: Error;
    pending?: { resolve: (c: Cursor) => void; reject: (e: Error) => void };
    sequence = 0;
    #tail = Promise.resolve();
    stderr = "";
    timer: ReturnType<typeof setTimeout>;
    context: Context;
    abort: () => void;
    #closed?: Promise<void>;
    readonly #exited: Promise<void>;
    readonly password?: SshPasswordLease;
    readonly authorize?: () => void;
    constructor(
        host: string,
        context: Context,
        password?: SshPasswordLease,
        authorize?: () => void,
    ) {
        this.context = context;
        this.password = password;
        this.authorize = authorize;
        authorize?.();
        const base = args(host, password !== undefined);

        base.splice(base.length - 1, 0, "-s");
        this.child = spawn("ssh", [...base, "sftp"], {
            stdio: "pipe",
            ...(password === undefined ? {} : { env: { ...process.env, ...password.env } }),
        });

        this.#exited = new Promise((resolve) => this.child.once("close", () => resolve()));

        try {
            if (this.child.pid !== undefined) {
                password?.authorize(this.child.pid);
            }
        } catch (error) {
            this.child.on("error", () => {});
            this.child.kill();

            throw error;
        }

        this.abort = () =>
            this.fail(
                new FileError(
                    "aborted",
                    "SSH operation interrupted; mutation outcome may be unknown. Do not replay automatically.",
                ),
            );
        context.abortSignal?.addEventListener("abort", this.abort, { once: true });
        this.timer = setTimeout(
            () =>
                this.fail(
                    new FileError(
                        "unknown",
                        "SFTP timed out; mutation outcome may be unknown. No retry was attempted.",
                    ),
                ),
            30_000,
        );
        this.timer.unref();
        this.child.stdout.on("data", (chunk: Buffer) => {
            this.buffer = Buffer.concat([this.buffer, chunk]);

            try {
                while (this.buffer.length >= 4) {
                    const length = this.buffer.readUInt32BE(0);

                    if (length > MAX_PACKET || length < 1) {
                        throw new Error("Invalid SFTP packet size");
                    }

                    if (this.buffer.length < length + 4) {
                        break;
                    }

                    const packet = this.buffer.subarray(4, length + 4);

                    this.buffer = this.buffer.subarray(length + 4);
                    const pending = this.pending;

                    this.pending = undefined;

                    if (!pending) {
                        throw new Error("Unexpected SFTP response");
                    }

                    pending.resolve(new Cursor(packet));
                }
            } catch (e) {
                this.fail(e instanceof Error ? e : new Error(String(e)));
            }
        });
        this.child.stderr.on("data", (b: Buffer) => {
            this.stderr = (this.stderr + b.toString()).slice(-8192);
        });
        this.child.stdin.on("error", (e) => this.fail(e));
        this.child.on("error", (e) => this.fail(e));
        this.child.on("close", () =>
            this.fail(
                new FileError(
                    "unknown",
                    `SSH/SFTP connection closed. ${this.stderr} Mutation outcome may be unknown; no retry was attempted.`,
                ),
            ),
        );

        if (context.abortSignal?.aborted) {
            this.abort();
        }
    }
    fail(e: Error) {
        this.failure ??= e;
        this.pending?.reject(this.failure);
        this.pending = undefined;
        void this.close();
    }
    close(): Promise<void> {
        if (this.#closed !== undefined) {
            return this.#closed;
        }

        this.failure ??= new FileError("aborted", "The SFTP session is closed.");
        this.pending?.reject(this.failure);
        this.pending = undefined;
        clearTimeout(this.timer);
        this.context.abortSignal?.removeEventListener("abort", this.abort);
        this.child.stdin.end();
        this.child.kill();
        this.#closed = (async () => {
            // Join the local transport; losing it still cannot attest remote mutation completion.
            const grace = setTimeout(() => this.child.kill("SIGKILL"), 1000);

            try {
                await Promise.all([this.#exited, this.password?.close().catch(() => {})]);
            } finally {
                clearTimeout(grace);
            }
        })();

        return this.#closed;
    }
    async exchange(packet: Buffer): Promise<Cursor> {
        const previous = this.#tail;
        let release!: () => void;

        this.#tail = new Promise<void>((resolve) => {
            release = resolve;
        });
        await previous;

        try {
            if (this.failure) {
                throw this.failure;
            }

            // Authentication and the preceding queued request may have awaited a policy change.
            // Reauthorize at dispatch, before any filesystem effect, and before returning its data.
            this.authorize?.();
            this.timer.refresh();
            const response = await new Promise<Cursor>((resolve, reject) => {
                this.pending = { resolve, reject };
                this.child.stdin.write(Buffer.concat([u32(packet.length), packet]));
            });

            this.authorize?.();

            return response;
        } finally {
            release();
        }
    }
    async withContext<T>(context: Context, fn: () => Promise<T>): Promise<T> {
        context.abortSignal?.addEventListener("abort", this.abort, { once: true });

        try {
            if (context.abortSignal?.aborted) {
                this.abort();

                throw this.failure;
            }

            return await fn();
        } finally {
            if (context !== this.context) {
                context.abortSignal?.removeEventListener("abort", this.abort);
            }
        }
    }
    async init() {
        const c = await this.exchange(Buffer.concat([Buffer.from([1]), u32(3)]));

        if (c.data[0] !== 2 || c.data.readUInt32BE(1) !== 3) {
            throw new FileError("not_supported", "Requires SFTP v3");
        }
    }
    async request(type: number, ...parts: Buffer[]): Promise<{ type: number; c: Cursor }> {
        const id = ++this.sequence;
        const c = await this.exchange(Buffer.concat([Buffer.from([type]), u32(id), ...parts]));
        const response = c.data[0]!;

        c.offset = 1;

        if (c.uint() !== id) {
            throw new Error("SFTP response id mismatch");
        }

        if (response === 101) {
            const status = c.uint();
            const message = c.text();

            if (status !== 0 && status !== 1) {
                throw new FileError(
                    status === 2
                        ? "not_found"
                        : status === 3
                          ? "permission_denied"
                          : status === 8
                            ? "not_supported"
                            : "unknown",
                    message,
                );
            }

            return { type: status === 1 ? -1 : 101, c };
        }

        return { type: response, c };
    }
    async open(path: string, flags: number) {
        const { type, c } = await this.request(3, str(path), u32(flags), u32(0));

        if (type !== 102) {
            throw new Error("Expected SFTP handle");
        }

        return c.bytes();
    }
    async closeHandle(handle: Buffer) {
        if (!this.failure) {
            await this.request(4, str(handle));
        }
    }
    async realpath(path: string) {
        const { c } = await this.request(16, str(path));

        c.uint();

        return c.text();
    }
    async stat(path: string, follow = false) {
        const { type, c } = await this.request(follow ? 17 : 7, str(path));

        if (type !== 105) {
            throw new Error("Expected SFTP attributes");
        }

        return c.attrs(path);
    }
    async read(handle: Buffer, offset: number, length: number) {
        const { type, c } = await this.request(5, str(handle), u64(offset), u32(length));

        if (type === -1) {
            return Buffer.alloc(0);
        }

        if (type !== 103) {
            throw new Error("Expected SFTP data");
        }

        return c.bytes();
    }
    async write(handle: Buffer, content: Uint8Array, offset = 0) {
        for (let start = 0; start < content.length; start += CHUNK) {
            await this.request(
                6,
                str(handle),
                u64(offset + start),
                str(content.subarray(start, start + CHUNK)),
            );
        }
    }
}

type FileSystemBatch = {
    active: boolean;
    context: Context;
    connection?: Promise<Sftp>;
    session?: Sftp;
    credential?: SshPasswordCredential;
};

/** Share a transport only inside this awaited compound read, never across users or requests. */
export async function withSshFileSystem<T>(
    env: ExecutionEnv,
    operation: () => Promise<T>,
    context: Context = BACKGROUND_CONTEXT,
): Promise<T> {
    return env instanceof SshExecutionEnv
        ? getOrThrow(await env.withFileSystem(operation, context))
        : operation();
}

export class SshExecutionEnv implements ExecutionEnv {
    readonly host: string;
    readonly id: string;
    cwd: string;
    #sessions = new Set<Sftp>();
    #commands = new Set<() => void>();
    #running = new Set<Promise<Result<ShellExecResult, ExecutionError>>>();
    #temporary = new Set<string>();
    #observed = new Map<string, { size: number; mtimeMs: number; hash?: string }>();
    #fileSystem = new AsyncLocalStorage<FileSystemBatch>();
    readonly #password?: () => SshPasswordCredential | undefined;
    readonly #authorize?: () => void;
    constructor(options: {
        host: string;
        cwd: string;
        password?: () => SshPasswordCredential | undefined;
        authorize?: () => void;
    }) {
        this.host = validateSshHost(options.host);
        this.cwd = options.cwd;
        this.id = `ssh:${this.host}`;
        this.#password = options.password;
        this.#authorize = options.authorize;
    }
    async #connect(context: Context) {
        const batch = this.#fileSystem.getStore();

        if (batch?.context.abortSignal !== undefined) {
            context = withAbortSignal(batch.context.abortSignal, context);
        }

        if (context.abortSignal?.aborted) {
            throw new FileError("aborted", "Aborted before connecting");
        }

        const credential = this.#password?.();

        if (batch !== undefined) {
            if (!batch.active) {
                throw new FileError("aborted", "The compound filesystem request has finished.");
            }

            if (batch.connection !== undefined && batch.credential !== credential) {
                throw new FileError("permission_denied", "SSH login changed during this request.");
            }

            if (batch.connection === undefined) {
                batch.credential = credential;
                batch.connection = this.#open(context, credential).then((session) => {
                    batch.session = session;

                    return session;
                });
            }

            return batch.connection;
        }

        return this.#open(context, credential);
    }
    async #open(context: Context, credential?: SshPasswordCredential): Promise<Sftp> {
        const password = await credential?.prepare();

        if (context.abortSignal?.aborted) {
            await password?.close();

            throw new FileError("aborted", "SSH authentication was cancelled before connecting.");
        }

        let s: Sftp;

        try {
            s = new Sftp(this.host, context, password, this.#authorize);
        } catch (error) {
            await password?.close();

            throw error;
        }

        this.#sessions.add(s);

        try {
            await s.init();

            return s;
        } catch (e) {
            await this.#close(s);

            throw e;
        }
    }
    async #close(s: Sftp) {
        this.#sessions.delete(s);
        await s.close();
    }
    async #release(s: Sftp) {
        if (this.#fileSystem.getStore()?.session !== s) {
            await this.#close(s);
        }
    }
    /** One lazy, request-local transport. Callers must await all work and close readers before returning.
     * No cross-request pooling: credentials are rechecked per operation and the session closes in finally.
     */
    async withFileSystem<T>(
        operation: () => Promise<T>,
        context: Context,
    ): Promise<Result<T, FileError>> {
        if (context.abortSignal?.aborted) {
            return err(new FileError("aborted", "Filesystem request was cancelled."));
        }

        const inherited = this.#fileSystem.getStore();

        if (inherited !== undefined) {
            if (!inherited.active) {
                return err(
                    new FileError("aborted", "The compound filesystem request has finished."),
                );
            }

            return ok(await operation());
        }

        const batch: FileSystemBatch = { active: true, context };
        let value: T;

        try {
            value = await this.#fileSystem.run(batch, operation);
        } finally {
            batch.active = false;
            const session = await batch.connection?.catch(() => undefined);

            if (session !== undefined) {
                await this.#close(session);
            }
        }

        if (batch.connection !== undefined && this.#password?.() !== batch.credential) {
            return err(
                new FileError("permission_denied", "SSH login changed during this request."),
            );
        }

        return ok(value);
    }
    async #path(path: string, s: Sftp) {
        if (path.includes("\0")) {
            throw new FileError("invalid", "NUL in path", path);
        }

        if (posix.isAbsolute(path)) {
            return posix.normalize(path);
        }

        let cwd = this.cwd;
        const home = () => s.realpath(".");

        if (path === "~" || path.startsWith("~/")) {
            return posix.join(await home(), path.slice(2));
        }

        if (cwd === "~" || cwd.startsWith("~/")) {
            cwd = posix.join(await home(), cwd.slice(2));
        }

        if (!posix.isAbsolute(cwd)) {
            cwd = posix.join(await home(), cwd);
        }

        return posix.resolve(cwd, path);
    }
    async #use<T>(context: Context, fn: (s: Sftp) => Promise<T>): Promise<Result<T, FileError>> {
        let s: Sftp | undefined;

        try {
            s = await this.#connect(context);
            const connection = s;

            return ok(await connection.withContext(context, () => fn(connection)));
        } catch (e) {
            return err(
                e instanceof FileError
                    ? e
                    : new FileError("unknown", e instanceof Error ? e.message : String(e)),
            );
        } finally {
            if (s) {
                await this.#release(s);
            }
        }
    }
    async absolutePath(path: string, context: Context): Promise<Result<string, FileError>> {
        if (context.abortSignal?.aborted) {
            return err(new FileError("aborted", "Path resolution was cancelled."));
        }

        if (path.includes("\0")) {
            return err(new FileError("invalid", "NUL in path", path));
        }

        if (posix.isAbsolute(path)) {
            return ok(posix.normalize(path));
        }

        if (path !== "~" && !path.startsWith("~/") && posix.isAbsolute(this.cwd)) {
            return ok(posix.resolve(this.cwd, path));
        }

        return this.#use(context, (s) => this.#path(path, s));
    }
    async joinPath(parts: string[], _context: Context): Promise<Result<string, FileError>> {
        return ok(posix.join(...parts));
    }
    async canonicalPath(path: string, context: Context) {
        return this.#use(context, async (s) => s.realpath(await this.#path(path, s)));
    }
    async fileInfo(path: string, context: Context) {
        return this.#use(context, async (s) => s.stat(await this.#path(path, s)));
    }
    /** Non-following metadata for trusted repository inspection; ordinary FileInfo is unchanged. */
    async lstat(
        path: string,
        context: Context,
    ): Promise<Result<FileInfo & { mode: number }, FileError>> {
        return this.#use(context, async (s) => {
            const absolute = await this.#path(path, s);
            const { type, c } = await s.request(7, str(absolute));

            if (type !== 105) {
                throw new FileError("unknown", "Expected SFTP attributes", path);
            }

            const info = c.attrs(absolute, true);

            if (info.mode === undefined) {
                throw new FileError("not_supported", "SFTP did not provide file mode", path);
            }

            return { ...info, mode: info.mode };
        });
    }
    /** Raw target bytes, not a decoded pathname or shell output. SFTP packets are size-bounded. */
    async readlink(path: string, context: Context): Promise<Result<Uint8Array, FileError>> {
        return this.#use(context, async (s) => {
            const { type, c } = await s.request(19, str(await this.#path(path, s)));

            if (type !== 104 || c.uint() !== 1) {
                throw new FileError("unknown", "Expected one SFTP symlink target", path);
            }

            return Uint8Array.from(c.bytes());
        });
    }
    async exists(path: string, context: Context): Promise<Result<boolean, FileError>> {
        const r = await this.fileInfo(path, context);

        return r.ok ? ok(true) : r.error.code === "not_found" ? ok(false) : r;
    }
    async writeFile(path: string, content: string | Uint8Array, context: Context) {
        return this.#write(path, content, 2 | 8 | 16, context);
    }
    async appendFile(path: string, content: string | Uint8Array, context: Context) {
        return this.#write(path, content, 2 | 4 | 8, context);
    }
    /** Best-effort optimistic edit check, not CAS: another writer can still race after comparison.
     * Whole-file reads retain a digest; partial reads retain SFTP's second-resolution metadata only.
     */
    async #checkObserved(path: string, s: Sftp) {
        const previous = this.#observed.get(path);

        if (!previous) {
            return;
        }

        const conflict = () =>
            new FileError(
                "invalid",
                "Edit conflict: remote file changed after it was read. Read it again before editing.",
                path,
            );
        let current: FileInfo;

        try {
            current = await s.stat(path, true);
        } catch (e) {
            if (e instanceof FileError && e.code === "not_found") {
                throw conflict();
            }

            throw e;
        }

        if (current.size !== previous.size || current.mtimeMs !== previous.mtimeMs) {
            throw conflict();
        }

        if (previous.hash) {
            const handle = await s.open(path, 1);
            const hash = createHash("sha256");

            try {
                for (let offset = 0; ; offset += CHUNK) {
                    const bytes = await s.read(handle, offset, CHUNK);

                    hash.update(bytes);

                    if (bytes.length < CHUNK) {
                        break;
                    }
                }
            } finally {
                await s.closeHandle(handle);
            }

            if (hash.digest("hex") !== previous.hash) {
                throw conflict();
            }
        }
    }
    async #write(path: string, content: string | Uint8Array, flags: number, context: Context) {
        return this.#use(context, async (s) => {
            const absolute = await this.#path(path, s);

            await this.#checkObserved(absolute, s);
            const h = await s.open(absolute, flags);

            try {
                await s.write(h, typeof content === "string" ? Buffer.from(content) : content);
                this.#observed.delete(absolute);
            } catch (e) {
                throw new FileError(
                    e instanceof FileError ? e.code : "unknown",
                    `Remote write may have partially applied; do not replay automatically. ${String(e)}`,
                    absolute,
                );
            } finally {
                await s.closeHandle(h);
            }
        });
    }
    async truncateFile(path: string, size: number, context: Context) {
        return this.#use(context, async (s) => {
            if (!Number.isSafeInteger(size) || size < 0) {
                throw new FileError("invalid", "Invalid file size");
            }

            const absolute = await this.#path(path, s);

            await this.#checkObserved(absolute, s);
            await s.request(9, str(absolute), u32(1), u64(size));
            this.#observed.delete(absolute);
        });
    }
    async flushFile(_path: string, _context: Context): Promise<Result<void, FileError>> {
        return err(new FileError("not_supported", "SFTP v3 does not guarantee durable flush"));
    }
    async renameFile(source: string, destination: string, context: Context) {
        return this.#use(context, async (s) => {
            const from = await this.#path(source, s);
            const to = await this.#path(destination, s);

            await s.request(18, str(from), str(to));
            this.#observed.delete(from);
            this.#observed.delete(to);
        });
    }
    async openBinaryReader(
        path: string,
        options: { noFollow?: boolean } | undefined,
        context: Context,
    ): Promise<Result<BinaryReader, FileError>> {
        let s: Sftp | undefined;

        try {
            s = await this.#connect(context);
            const connection = s;
            const absolute = await this.#path(path, s);

            if (options?.noFollow) {
                throw new FileError(
                    "not_supported",
                    "SFTP v3 cannot atomically enforce noFollow",
                    path,
                );
            }

            const info = await s.stat(absolute, true);

            if (info.kind !== "file") {
                throw new FileError(
                    info.kind === "directory" ? "is_directory" : "invalid",
                    "Not a regular file",
                    path,
                );
            }

            const h = await s.open(absolute, 1);
            const opened = await s.request(8, str(h));
            const openedInfo = opened.c.attrs(absolute);

            if (openedInfo.kind !== "file") {
                throw new FileError("invalid", "Opened handle is not a regular file", path);
            }

            const observed: { size: number; mtimeMs: number; hash?: string } = {
                size: openedInfo.size,
                mtimeMs: openedInfo.mtimeMs,
            };

            this.#observed.set(absolute, observed);

            const call = async <T>(
                ctx: Context,
                fn: () => Promise<T>,
            ): Promise<Result<T, FileError>> => {
                try {
                    return ok(await connection.withContext(ctx, fn));
                } catch (e) {
                    return err(
                        e instanceof FileError ? e : new FileError("unknown", String(e), path),
                    );
                }
            };

            const read = async (offset: number, length: number) => {
                if (
                    !Number.isSafeInteger(offset) ||
                    offset < 0 ||
                    !Number.isSafeInteger(length) ||
                    length < 0 ||
                    length > MAX_READ
                ) {
                    throw new FileError("invalid", "Invalid or oversized read", path);
                }

                const chunks: Buffer[] = [];
                let total = 0;

                while (total < length) {
                    const b = await connection.read(
                        h,
                        offset + total,
                        Math.min(CHUNK, length - total),
                    );

                    if (!b.length) {
                        break;
                    }

                    chunks.push(b);
                    total += b.length;
                }

                const bytes = Buffer.concat(chunks);

                if (offset === 0 && length >= observed.size && bytes.length === observed.size) {
                    observed.hash = createHash("sha256").update(bytes).digest("hex");
                }

                return bytes;
            };

            return ok({
                info: (ctx) =>
                    call(ctx, async () => {
                        const { c } = await connection.request(8, str(h));

                        return c.attrs(absolute);
                    }),
                read: (offset, length, ctx) => call(ctx, () => read(offset, length)),
                scanLines: (range, ctx) =>
                    call(ctx, async () => {
                        const scanner = new LineScanner(range.startLine, range.endLine);
                        const hash = createHash("sha256");

                        for (let offset = 0; ; offset += CHUNK) {
                            const b = await read(offset, CHUNK);

                            scanner.push(b);
                            hash.update(b);

                            if (b.length < CHUNK) {
                                break;
                            }
                        }

                        observed.hash = hash.digest("hex");

                        return scanner.finish();
                    }),
                close: async () => {
                    try {
                        await connection.closeHandle(h);
                    } finally {
                        await this.#release(connection);
                    }
                },
            });
        } catch (e) {
            if (s) {
                await this.#close(s);
            }

            return err(e instanceof FileError ? e : new FileError("unknown", String(e), path));
        }
    }
    async readBinaryFile(path: string, context: Context): Promise<Result<Uint8Array, FileError>> {
        const r = await this.openBinaryReader(path, undefined, context);

        if (!r.ok) {
            return r;
        }

        try {
            const info = await r.value.info(context);

            if (!info.ok) {
                return info;
            }

            if (info.value.size > MAX_READ) {
                return err(
                    new FileError("invalid", "File exceeds 32 MiB; use bounded reads", path),
                );
            }

            return await r.value.read(0, MAX_READ, context);
        } finally {
            await r.value.close(context);
        }
    }
    async readTextFile(path: string, context: Context): Promise<Result<string, FileError>> {
        const r = await this.readBinaryFile(path, context);

        return r.ok ? ok(new TextDecoder().decode(r.value)) : r;
    }
    async openTextLineReader(
        path: string,
        context: Context,
    ): Promise<Result<TextLineReader, FileError>> {
        const r = await this.openBinaryReader(path, undefined, context);

        if (!r.ok) {
            return r;
        }

        let offset = 0;
        let text = "";
        let ended = false;
        const decoder = new TextDecoder();

        return ok({
            readLine: async (ctx) => {
                while (!text.includes("\n") && !ended) {
                    const b = await r.value.read(offset, CHUNK, ctx);

                    if (!b.ok) {
                        return b;
                    }

                    offset += b.value.length;
                    ended = b.value.length < CHUNK;
                    text += decoder.decode(b.value, { stream: !ended });

                    if (text.length > MAX_READ) {
                        return err(new FileError("invalid", "Line exceeds 32 MiB", path));
                    }
                }

                const newline = text.indexOf("\n");

                if (newline >= 0) {
                    const line = text.slice(0, newline).replace(/\r$/, "");

                    text = text.slice(newline + 1);

                    return ok({ text: line, terminated: true });
                }

                if (!text) {
                    return ok(undefined);
                }

                const line = text;

                text = "";

                return ok({ text: line, terminated: false });
            },
            close: (ctx) => r.value.close(ctx),
        });
    }
    async readTextLines(
        path: string,
        options: { maxLines?: number } | undefined,
        context: Context,
    ): Promise<Result<string[], FileError>> {
        const r = await this.openTextLineReader(path, context);

        if (!r.ok) {
            return r;
        }

        const lines: string[] = [];
        let bytes = 0;

        try {
            while (lines.length < (options?.maxLines ?? Infinity)) {
                const line = await r.value.readLine(context);

                if (!line.ok) {
                    return line;
                }

                if (!line.value) {
                    break;
                }

                bytes += Buffer.byteLength(line.value.text);

                if (bytes > MAX_READ) {
                    return err(new FileError("invalid", "Text exceeds 32 MiB", path));
                }

                lines.push(line.value.text);
            }

            return ok(lines);
        } finally {
            await r.value.close(context);
        }
    }
    async openDirReader(path: string, context: Context): Promise<Result<DirReader, FileError>> {
        let s: Sftp | undefined;

        try {
            s = await this.#connect(context);
            const connection = s;
            const absolute = await this.#path(path, s);
            const { c } = await s.request(11, str(absolute));
            const h = c.bytes();
            let done = false;
            let pending: FileInfo[] = [];

            return ok({
                next: async (maxEntries, ctx) => {
                    try {
                        return await connection.withContext(ctx, async () => {
                            if (!Number.isInteger(maxEntries) || maxEntries < 1) {
                                throw new FileError("invalid", "Invalid page size");
                            }

                            if (!pending.length && !done) {
                                const r = await connection.request(12, str(h));

                                done = r.type === -1;

                                if (!done) {
                                    const count = r.c.uint();

                                    for (let i = 0; i < count; i++) {
                                        const name = r.c.text();

                                        r.c.text();

                                        try {
                                            const info = r.c.attrs(posix.join(absolute, name));

                                            if (name !== "." && name !== "..") {
                                                pending.push(info);
                                            }
                                        } catch (e) {
                                            if (
                                                !(e instanceof FileError) ||
                                                e.code !== "not_supported"
                                            ) {
                                                throw e;
                                            }
                                        }
                                    }
                                }
                            }

                            const entries = pending.splice(0, maxEntries);

                            return ok({ entries, done: done && !pending.length });
                        });
                    } catch (e) {
                        return err(
                            e instanceof FileError ? e : new FileError("unknown", String(e), path),
                        );
                    }
                },
                close: async () => {
                    try {
                        await connection.closeHandle(h);
                    } finally {
                        await this.#release(connection);
                    }
                },
            });
        } catch (e) {
            if (s) {
                await this.#close(s);
            }

            return err(e instanceof FileError ? e : new FileError("unknown", String(e), path));
        }
    }
    async listDir(path: string, context: Context): Promise<Result<FileInfo[], FileError>> {
        const r = await this.openDirReader(path, context);

        if (!r.ok) {
            return r;
        }

        const entries: FileInfo[] = [];

        try {
            for (;;) {
                const page = await r.value.next(256, context);

                if (!page.ok) {
                    return page;
                }

                entries.push(...page.value.entries);

                if (entries.length > 100_000) {
                    return err(
                        new FileError(
                            "invalid",
                            "Directory exceeds entry limit; use paged reads",
                            path,
                        ),
                    );
                }

                if (page.value.done) {
                    return ok(entries);
                }
            }
        } finally {
            await r.value.close(context);
        }
    }
    async createDir(path: string, options: { recursive?: boolean } | undefined, context: Context) {
        return this.#use(context, async (s) => {
            const absolute = await this.#path(path, s);
            const paths = options?.recursive
                ? absolute
                      .split("/")
                      .slice(1)
                      .map((_, i, parts) => "/" + parts.slice(0, i + 1).join("/"))
                : [absolute];

            for (const p of paths) {
                try {
                    await s.request(14, str(p), u32(0));
                } catch (e) {
                    if (!options?.recursive || (await s.stat(p, true)).kind !== "directory") {
                        throw e;
                    }
                }
            }
        });
    }
    async remove(
        path: string,
        options: { recursive?: boolean; force?: boolean } | undefined,
        context: Context,
    ): Promise<Result<void, FileError>> {
        if (options?.recursive) {
            return err(
                new FileError(
                    "not_supported",
                    "Recursive removal requires an explicit remote shell command",
                    path,
                ),
            );
        }

        const r = await this.#use(context, async (s) => {
            const p = await this.#path(path, s);
            const info = await s.stat(p);

            await s.request(info.kind === "directory" ? 15 : 13, str(p));
            this.#observed.delete(p);
            this.#temporary.delete(p);
        });

        return !r.ok && r.error.code === "not_found" && options?.force ? ok(undefined) : r;
    }
    async createTempFile(
        options: { prefix?: string; suffix?: string } | undefined,
        context: Context,
    ) {
        return this.#use(context, async (s) => {
            const name = `/tmp/${posix.basename(options?.prefix ?? "pi-coop-")}${randomUUID()}${posix.basename(options?.suffix ?? "")}`;
            const { c } = await s.request(3, str(name), u32(2 | 8 | 32), u32(4), u32(0o600));

            await s.closeHandle(c.bytes());
            this.#temporary.add(name);

            return name;
        });
    }
    async createTempDir(prefix: string | undefined, context: Context) {
        return this.#use(context, async (s) => {
            const name = `/tmp/${posix.basename(prefix ?? "pi-coop-")}${randomUUID()}`;

            await s.request(14, str(name), u32(4), u32(0o700));
            this.#temporary.add(name);

            return name;
        });
    }
    async watch(
        _targets: readonly WatchTarget[],
        _onChange: (change: WatchChange) => void,
        _context: Context,
    ): Promise<Result<FileWatcher, FileError>> {
        return err(
            new FileError("not_supported", "SSH workspaces do not provide filesystem watchers"),
        );
    }
    async cleanup(context: Context) {
        for (const stop of this.#commands) {
            stop();
        }

        for (const s of this.#sessions) {
            await this.#close(s);
        }

        await Promise.allSettled(this.#running);

        // Empty directories and spill files only; no recursive deletion of unknown remote content.
        for (const path of this.#temporary) {
            await this.remove(path, { force: true }, context);
        }

        this.#observed.clear();
    }

    async exec(
        command: string | readonly string[],
        options: ShellExecOptions | undefined,
        context: Context,
    ): Promise<Result<ShellExecResult, ExecutionError>> {
        return this.#exec(command, options, context);
    }

    /** Trusted repository capability. Policy-wrapped environments deliberately hide this entry point. */
    async execConfined(
        readOnly: boolean,
        command: string | readonly string[],
        options: ShellExecOptions | undefined,
        context: Context,
    ): Promise<Result<ShellExecResult, ExecutionError>> {
        return this.#exec(command, options, context, readOnly);
    }

    async #exec(
        command: string | readonly string[],
        options: ShellExecOptions | undefined,
        context: Context,
        readOnly?: boolean,
    ): Promise<Result<ShellExecResult, ExecutionError>> {
        if (context.abortSignal?.aborted) {
            return err(new ExecutionError("aborted", "Aborted before connecting"));
        }

        const values = typeof command === "string" ? [command] : command;

        if (
            [...values, ...Object.values(options?.env ?? {})].some((value) => value.includes("\0"))
        ) {
            return err(
                new ExecutionError(
                    "spawn_error",
                    "NUL bytes are not valid command arguments or environment values",
                ),
            );
        }

        if (
            options?.timeout !== undefined &&
            (!Number.isFinite(options.timeout) || options.timeout <= 0)
        ) {
            return err(new ExecutionError("timeout", "Invalid timeout"));
        }

        if (Array.isArray(command) && !command.length) {
            return err(new ExecutionError("spawn_error", "Empty command"));
        }

        if (
            options?.env &&
            Object.keys(options.env).some((key) => !/^[A-Za-z_][A-Za-z0-9_]*$/.test(key))
        ) {
            return err(new ExecutionError("spawn_error", "Invalid environment variable name"));
        }

        const cwd = await this.absolutePath(options?.cwd ?? ".", context);

        if (!cwd.ok) {
            return err(
                new ExecutionError(
                    cwd.error.code === "aborted" ? "aborted" : "spawn_error",
                    cwd.error.message,
                ),
            );
        }

        let spill: { s: Sftp; handle: Buffer; path: string; offset: number } | undefined;

        if (options?.spill) {
            const temp = await this.createTempFile(undefined, context);

            if (!temp.ok) {
                return err(
                    new ExecutionError(
                        temp.error.code === "aborted" ? "aborted" : "spawn_error",
                        temp.error.message,
                    ),
                );
            }

            try {
                const s = await this.#connect(context);
                const handle = await s.open(temp.value, 2);

                spill = { s, handle, path: temp.value, offset: 0 };
            } catch (e) {
                return err(new ExecutionError("spawn_error", String(e)));
            }
        }

        const managed = readOnly !== undefined;
        let body = typeof command === "string" ? command : `exec ${command.map(q).join(" ")}`;

        if (managed) {
            // Resolve Git on the target, under confinement. Never use the host's selected toolchain.
            const gitSetup = `for candidate in /Library/Developer/CommandLineTools/usr/bin/git /Applications/Xcode.app/Contents/Developer/usr/bin/git; do if [ -x "$candidate" ]; then export PATH="\${candidate%/*}:$PATH"; break; fi; done\nexport GIT_OPTIONAL_LOCKS=0\n`;

            if (typeof command !== "string" && command[0] === "/usr/bin/git") {
                body = `exec git ${command.slice(1).map(q).join(" ")}`;
            }

            body = gitSetup + body;
        }

        const environment = Object.entries(options?.env ?? {})
            .map(([key, value]) => `${key}=${q(value)}`)
            .join(" ");
        const chatInvoke = `${options?.inheritEnv === false ? 'env -i PATH="$PATH" HOME="$HOME" ' : "env "}${environment} bash -c ${q(body)}`;
        // Caller environment belongs beneath seatbelt. The unsandboxed transport supervisor gets
        // only PATH/HOME, uses fixed native executables, and never evaluates workload startup files.
        const invoke = managed
            ? `/usr/bin/sandbox-exec -p ${q(sandboxProfile(readOnly === true))} /usr/bin/env ${options?.inheritEnv === false ? '-i PATH="$PATH" HOME="$HOME" ' : ""}${environment} /bin/bash --noprofile --norc -c ${q(body)}`
            : chatInvoke;
        // Job control creates a separate group for this command. EOF on the control pipe attempts
        // TERM, then STOP/KILL of that group, including ordinary descendants, not unrelated SSH sessions.
        // Freeze before KILL: killing a child first must not wake a waiting shell into its next command.
        // Programs that deliberately escape their process group cannot be contained by SSH alone.
        const sleep = managed ? "/bin/sleep" : "sleep";
        const script = `cd ${q(cwd.value)} || exit\nexec 3<&0\nset -m\n${invoke} </dev/null &\npid=$!\nparent=$$\nset +m\nstop() { trap '' HUP INT TERM USR1; kill -TERM -- \"-$pid\" 2>/dev/null; ${sleep} 1; kill -STOP -- \"-$pid\" 2>/dev/null; kill -KILL -- \"-$pid\" 2>/dev/null; }\ntrap 'stop; exit 130' HUP INT TERM USR1\n( IFS= read -r _ <&3; kill -USR1 \"$parent\" 2>/dev/null ) &\nmonitor=$!\nwait \"$pid\"\nstatus=$?\nkill \"$monitor\" 2>/dev/null\nwait \"$monitor\" 2>/dev/null\nexit \"$status\"`;

        const remoteCommand = managed
            ? `/usr/bin/env -i PATH="$PATH" HOME="$HOME" /bin/bash --noprofile --norc -c ${q(`if [ "$(/usr/bin/uname -s)" != Darwin ]; then printf '%s\\n' 'Managed SSH shell requires a supported target-native OS sandbox; no unrestricted fallback.' >&2; exit 126; fi\n${script}`)}`
            : `bash -c ${q(script)}`;
        let password: SshPasswordLease | undefined;

        try {
            password = await this.#password?.()?.prepare();
        } catch {
            if (spill) {
                await this.#release(spill.s);
            }

            return err(
                new ExecutionError(
                    "spawn_error",
                    "SSH password login is unavailable. Log in again before retrying.",
                ),
            );
        }

        const closePrepared = async () => {
            await password?.close().catch(() => {});

            if (spill) {
                await this.#release(spill.s);
            }
        };

        if (context.abortSignal?.aborted) {
            await closePrepared();

            return err(
                new ExecutionError("aborted", "SSH command was cancelled before connecting."),
            );
        }

        let child: ChildProcessWithoutNullStreams | undefined;

        try {
            // Password IPC preparation awaits filesystem work. Recheck the captured requester,
            // pinned destination and selected credential before any command can reach SSH.
            this.#authorize?.();
            child = spawn("ssh", [...args(this.host, password !== undefined), remoteCommand], {
                stdio: "pipe",
                ...(password === undefined ? {} : { env: { ...process.env, ...password.env } }),
            });

            if (child.pid !== undefined) {
                password?.authorize(child.pid);
            }
        } catch {
            child?.on("error", () => {});
            child?.kill();
            await closePrepared();

            return err(
                new ExecutionError(
                    "spawn_error",
                    "SSH command could not be started. No retry was attempted.",
                ),
            );
        }

        const sshChild = child;
        const running = new Promise<Result<ShellExecResult, ExecutionError>>((resolve) => {
            const child = sshChild;
            let failure: ExecutionError | undefined;
            let timeout: ReturnType<typeof setTimeout> | undefined;
            let grace: ReturnType<typeof setTimeout> | undefined;
            let queue = Promise.resolve();
            let bytes = 0;
            let lines = 0;
            let endsWithNewline = true;
            let finished = false;
            const decoders = {
                stdout: new StringDecoder("utf8"),
                stderr: new StringDecoder("utf8"),
            };

            const stop = (code: "aborted" | "timeout" = "aborted") => {
                failure ??= new ExecutionError(
                    code,
                    "Remote command interrupted. Process-group termination requested; remote completion is unconfirmed. Do not automatically replay.",
                );
                child.stdin.end("\n");
                grace ??= setTimeout(() => child.kill(), 2000);
            };

            const abort = () => stop();

            this.#commands.add(abort);
            context.abortSignal?.addEventListener("abort", abort, { once: true });

            if (context.abortSignal?.aborted) {
                abort();
            }

            if (options?.timeout) {
                timeout = setTimeout(
                    () => stop("timeout"),
                    Math.min(options.timeout * 1000, 2_147_483_647),
                );
            }

            child.stdin.on("error", () => {});

            for (const stream of ["stdout", "stderr"] as const) {
                child[stream].on("data", (chunk: Buffer) => {
                    child.stdout.pause();
                    child.stderr.pause();
                    queue = queue
                        .then(async () => {
                            bytes += chunk.length;
                            endsWithNewline = chunk.at(-1) === 10;

                            for (const b of chunk) {
                                if (b === 10) {
                                    lines++;
                                }
                            }

                            if (spill) {
                                await spill.s.write(spill.handle, chunk, spill.offset);
                                spill.offset += chunk.length;
                            }

                            const text = decoders[stream].write(chunk);

                            if (text) {
                                options?.onOutput?.(text, context, { stream });
                            }
                        })
                        .catch((e) => {
                            failure ??= new ExecutionError("callback_error", String(e));
                            stop();
                        })
                        .finally(() => {
                            child.stdout.resume();
                            child.stderr.resume();
                        });
                });
            }

            child.on("error", (e) => {
                failure ??= new ExecutionError("spawn_error", e.message);
            });
            child.on("close", async (code) => {
                if (finished) {
                    return;
                }

                finished = true;
                await password?.close().catch(() => {});
                await queue;
                clearTimeout(timeout);
                clearTimeout(grace);
                context.abortSignal?.removeEventListener("abort", abort);
                this.#commands.delete(abort);

                try {
                    for (const stream of ["stdout", "stderr"] as const) {
                        const text = decoders[stream].end();

                        if (text) {
                            options?.onOutput?.(text, context, { stream });
                        }
                    }
                } catch (e) {
                    failure ??= new ExecutionError("callback_error", String(e));
                }

                const spilled =
                    spill &&
                    options?.spill &&
                    (bytes > options.spill.afterBytes ||
                        lines + (bytes && !endsWithNewline ? 1 : 0) > options.spill.afterLines);

                if (spill) {
                    try {
                        await spill.s.closeHandle(spill.handle);

                        if (!spilled) {
                            await spill.s.request(13, str(spill.path));
                            this.#temporary.delete(spill.path);
                        }
                    } catch (e) {
                        failure ??= new ExecutionError(
                            "unknown",
                            `Output spill finalization failed: ${String(e)}`,
                        );
                    } finally {
                        await this.#release(spill.s);
                    }
                }

                if (code === 255 || code === null) {
                    failure ??= new ExecutionError(
                        "unknown",
                        "SSH transport lost or failed. Remote command outcome is unknown; no retry was attempted.",
                    );
                }

                if (failure) {
                    if (spilled && spill) {
                        failure.spillPath = spill.path;
                    }

                    resolve(err(failure));
                } else {
                    resolve(
                        ok({
                            exitCode: code ?? 1,
                            ...(spilled && spill ? { spillPath: spill.path } : {}),
                        }),
                    );
                }
            });
        });

        this.#running.add(running);

        try {
            return await running;
        } finally {
            this.#running.delete(running);
        }
    }
}
