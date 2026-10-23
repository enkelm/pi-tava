/** Read-only local Herdr discovery, with shared transport and input reservations for the private Pi bridge. */
import { execFile } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { lstat, readdir, stat } from "node:fs/promises";
import { createConnection } from "node:net";
import { homedir } from "node:os";
import { basename, dirname, isAbsolute, join } from "node:path";
import { promisify } from "node:util";
import { HttpError } from "../errors.ts";
import type { ControlPurpose, PrivateControl } from "../private-sessions/control.ts";

const execute = promisify(execFile);
const MAX_REPLY = 2 * 1024 * 1024;

export type ProcessIdentity = {
    pid: number;
    parent: number;
    uid: number;
    started: string;
    commandHash: string;
};

export type LocalProcess = ProcessIdentity & { command: string };

export type ActivePi = {
    id: string;
    socket: string;
    pane: string;
    path: string;
    title: string;
    cwd: string;
    location: string;
    state: string;
    process?: ProcessIdentity;
    reason?: string;
};

type Pane = {
    pane_id: string;
    workspace_id: string;
    agent?: string;
    agent_status: string;
    label?: string;
    cwd?: string;
    foreground_cwd?: string;
    agent_session?: { agent?: string; source?: string; kind?: string; value?: string };
};

type Snapshot = {
    panes: Pane[];
    workspaces: { workspace_id: string; label: string }[];
};

export type ProcessInfo = {
    shell_pid?: number;
    foreground_process_group_id?: number;
    foreground_processes: { pid: number; argv?: string[]; cwd?: string }[];
};

/** One bounded JSON-line exchange. No CLI, terminal input, subscriptions or shell interpolation. */
export function herdrRequest<T>(
    socketPath: string,
    method: string,
    params = {},
    timeoutMs = 2000,
    signal?: AbortSignal,
): Promise<T> {
    return new Promise((resolve, reject) => {
        signal?.throwIfAborted();
        const socket = createConnection(socketPath);
        const id = randomUUID();
        let text = "";
        let finished = false;
        let failure: Error | undefined;
        let value: T | undefined;

        const finish = (error?: Error, result?: T) => {
            if (finished) {
                return;
            }

            finished = true;
            failure = error;
            value = result;
            clearTimeout(timer);
            socket.destroy();
        };

        const abort = () => finish(new Error("Herdr request cancelled"));
        const timer = setTimeout(() => finish(new Error("Herdr did not respond")), timeoutMs);

        // Destroy requests cancellation; close joins the actual transport before settling its caller.
        socket.once("close", () => {
            clearTimeout(timer);
            signal?.removeEventListener("abort", abort);

            if (!finished || failure) {
                reject(failure ?? new Error("Herdr closed before replying"));
            } else {
                resolve(value!);
            }
        });
        signal?.addEventListener("abort", abort, { once: true });
        socket.setEncoding("utf8");
        socket.on("error", (error) => finish(error));
        socket.on("end", () => finish(new Error("Herdr closed before replying")));
        socket.on("connect", () => {
            if (!finished) {
                socket.write(`${JSON.stringify({ id, method, params })}\n`);
            }
        });
        socket.on("data", (chunk: string) => {
            if (finished) {
                return;
            }

            text += chunk;

            if (Buffer.byteLength(text) > MAX_REPLY) {
                finish(new Error("Herdr reply exceeded the discovery limit"));

                return;
            }

            const newline = text.indexOf("\n");

            if (newline < 0) {
                return;
            }

            try {
                const reply = JSON.parse(text.slice(0, newline));

                if (reply.id !== id || reply.error || !reply.result) {
                    throw new Error("Herdr refused the discovery request");
                }

                finish(undefined, reply.result);
            } catch (error) {
                finish(error instanceof Error ? error : new Error("Invalid Herdr reply"));
            }
        });
    });
}

/** Pi's executable, or Node running its installed CLI. A substring such as `echo pi` is not Pi. */
export function isPiArgv(argv: string[]): boolean {
    const executable = basename(argv[0] ?? "");
    const flags = argv.slice(0, argv.indexOf("--") < 0 ? argv.length : argv.indexOf("--"));

    if (
        flags.some(
            (flag, index) =>
                flag === "--print" ||
                flag === "-p" ||
                /^--mode=(?:rpc|json)$/.test(flag) ||
                (flag === "--mode" && ["rpc", "json"].includes(flags[index + 1] ?? "")),
        )
    ) {
        return false;
    }

    return (
        executable === "pi" ||
        ((executable === "node" || executable === "nodejs") &&
            /(?:^|\/)@(?:earendil-works|mariozechner)\/pi-coding-agent\/(?:dist|src)\/(?:cli|main|index|bundle\/(?:cli|index))\.(?:js|ts)$/.test(
                argv[1] ?? "",
            ))
    );
}

export function parseProcesses(text: string): LocalProcess[] {
    return text.split("\n").flatMap((line) => {
        const match =
            /^\s*(\d+)\s+(\d+)\s+(\d+)\s+(\S+)\s+(\w{3}\s+\w{3}\s+\d+\s+\d\d:\d\d:\d\d\s+\d{4})\s+(.+)$/.exec(
                line,
            );

        if (!match || match[4]!.includes("Z")) {
            return [];
        }

        const command = match[6]!.trimEnd();

        return [
            {
                pid: Number(match[1]),
                parent: Number(match[2]),
                uid: Number(match[3]),
                started: match[5]!.replace(/\s+/g, " "),
                command,
                commandHash: createHash("sha256").update(command).digest("hex"),
            },
        ];
    });
}

export async function localProcesses(signal?: AbortSignal): Promise<LocalProcess[]> {
    signal?.throwIfAborted();

    try {
        const execution = execute("/bin/ps", ["-axo", "pid=,ppid=,uid=,stat=,lstart=,command="], {
            env: { ...process.env, LC_ALL: "C" },
            timeout: 3000,
            maxBuffer: 4 * 1024 * 1024,
            ...(signal ? { signal } : {}),
        });
        const closed = new Promise<void>((resolve) =>
            execution.child.once("close", () => resolve()),
        );
        let stdout: string;

        try {
            ({ stdout } = await execution);
        } finally {
            await closed;
        }

        signal?.throwIfAborted();

        return parseProcesses(stdout);
    } catch {
        // Do not log ps output: unrelated process arguments may contain credentials.
        throw new HttpError(503, "Could not inspect local processes. Pi discovery is unavailable.");
    }
}

function beneath(table: LocalProcess[], pid: number, root: number | undefined): boolean {
    const seen = new Set<number>();
    let child = table.find((item) => item.pid === pid);

    while (child && !seen.has(child.pid)) {
        seen.add(child.pid);

        if (child.parent === root && table.some((item) => item.pid === root)) {
            return true;
        }

        child = table.find((item) => item.pid === child!.parent);
    }

    return false;
}

function idFor(candidate: Omit<ActivePi, "id">): string {
    return createHash("sha256")
        .update(
            JSON.stringify([candidate.socket, candidate.pane, candidate.path, candidate.process]),
        )
        .digest("hex");
}

/** Only owner-owned local sockets are discovered. The browser never supplies endpoints or PIDs. */
async function sockets(signal?: AbortSignal): Promise<string[]> {
    signal?.throwIfAborted();
    const inherited = process.env.HERDR_SOCKET_PATH;
    const roots = new Set([
        join(process.env.XDG_CONFIG_HOME || join(homedir(), ".config"), "herdr"),
    ]);

    if (inherited && isAbsolute(inherited)) {
        const directory = dirname(inherited);

        roots.add(
            basename(dirname(directory)) === "sessions" ? dirname(dirname(directory)) : directory,
        );
    }

    const paths = new Set<string>(inherited && isAbsolute(inherited) ? [inherited] : []);

    for (const root of roots) {
        signal?.throwIfAborted();
        paths.add(join(root, "herdr.sock"));
        const entries = await readdir(join(root, "sessions"), { withFileTypes: true }).catch(
            () => [],
        );

        for (const entry of entries.filter((item) => item.isDirectory()).slice(0, 32)) {
            paths.add(join(root, "sessions", entry.name, "herdr.sock"));
        }
    }

    const result: string[] = [];

    for (const path of paths) {
        signal?.throwIfAborted();
        const metadata = await lstat(path).catch(() => undefined);

        signal?.throwIfAborted();

        if (metadata?.isSocket() && metadata.uid === process.getuid?.()) {
            result.push(path);
        }
    }

    return result;
}

/** Shared foreground identity check for source discovery and the private Pi bridge. */
export function foregroundPi(table: LocalProcess[], info: ProcessInfo): LocalProcess | undefined {
    const matches = info.foreground_processes.filter((item) =>
        item.argv?.length
            ? isPiArgv(item.argv)
            : item.pid === info.foreground_process_group_id &&
              table.find((process) => process.pid === item.pid)?.command === "pi",
    );
    const foreground = matches.length === 1 ? matches[0] : undefined;
    const actual = table.find((item) => item.pid === foreground?.pid);

    if (
        !actual ||
        actual.uid !== process.getuid?.() ||
        actual.pid === info.shell_pid ||
        !beneath(table, actual.pid, info.shell_pid) ||
        !Number.isSafeInteger(info.foreground_process_group_id) ||
        info.foreground_process_group_id === info.shell_pid ||
        actual.command !== (foreground?.argv?.length ? foreground.argv.join(" ") : "pi")
    ) {
        return undefined;
    }

    return actual;
}

/** Conservative identity for non-Pi agents: a verified foreground group leader, never its shell.
 * A changing foreground job is an observation gap, not evidence of completion.
 */
export function foregroundAgent(
    table: LocalProcess[],
    info: ProcessInfo,
): LocalProcess | undefined {
    const foreground = info.foreground_processes.find(
        (item) => item.pid === info.foreground_process_group_id,
    );
    const actual = table.find((item) => item.pid === foreground?.pid);

    if (
        !actual ||
        actual.uid !== process.getuid?.() ||
        actual.pid === info.shell_pid ||
        !beneath(table, actual.pid, info.shell_pid) ||
        !Number.isSafeInteger(info.foreground_process_group_id) ||
        !foreground?.argv?.length ||
        actual.command !== foreground.argv.join(" ")
    ) {
        return undefined;
    }

    return actual;
}

type InputOperation = {
    socket: string;
    pane: string | undefined;
    purpose: ControlPurpose | "terminal";
};

/** Concrete OS/socket methods are shared with the private bridge and replaceable by synthetic fixtures. */
export class LocalPiSessions {
    processes = localProcesses;
    sockets = sockets;
    request = herdrRequest;
    /** Installed by PrivateSessions without reading storage during app construction. */
    control?: PrivateControl;
    readonly #operations = new Set<InputOperation>();

    setControl(control: PrivateControl): void {
        this.control = control;
    }

    async inputReason(socket: string, pane: string): Promise<string | undefined> {
        return this.control?.reason(socket, pane);
    }

    async requireInputSafe(socket: string, pane: string): Promise<void> {
        const reason = await this.inputReason(socket, pane);

        if (reason) {
            throw new HttpError(409, reason);
        }
    }

    #reserve(
        socket: string,
        pane: string | undefined,
        purpose: InputOperation["purpose"],
    ): InputOperation {
        if (
            [...this.#operations].some(
                (item) =>
                    item.socket === socket &&
                    (pane === undefined || item.pane === undefined || item.pane === pane),
            )
        ) {
            throw new HttpError(409, "This pane or Herdr instance already has input in progress.");
        }

        const reservation = { socket, pane, purpose };

        this.#operations.add(reservation);

        return reservation;
    }

    /** Reserve before durable admission and native writes. Undefined pane is instance-wide.
     * Explicit terminal control ignores durable Chat uncertainty, but cannot overlap another input.
     * Release means the callback ended, not that Herdr drained its PTY.
     */
    async withTerminalInput<T>(
        socket: string,
        pane: string | undefined,
        operation: () => T | Promise<T>,
    ): Promise<T> {
        const reservation = this.#reserve(socket, pane, "terminal");

        try {
            return await operation();
        } finally {
            this.#operations.delete(reservation);
        }
    }

    /** Serialize bridge input and native writes, not read-only discovery or an attached terminal's lifetime. */
    async withPane<T>(
        socket: string,
        pane: string,
        operation: () => Promise<T>,
        purpose: ControlPurpose = "prompt",
    ): Promise<T> {
        // Reserve synchronously, before durable I/O, so a conflicting native write cannot slip across it.
        const reservation = this.#reserve(socket, pane, purpose);

        try {
            await this.requireInputSafe(socket, pane);

            return await operation();
        } finally {
            this.#operations.delete(reservation);
        }
    }

    withInput<T>(
        socket: string,
        pane: string,
        operation: () => Promise<T>,
        purpose: ControlPurpose = "prompt",
    ): Promise<T> {
        return this.withPane(socket, pane, operation, purpose);
    }

    async list(): Promise<{ sessions: ActivePi[]; warnings: string[] }> {
        if (process.platform !== "darwin" && process.platform !== "linux") {
            return {
                sessions: [],
                warnings: ["Local Herdr Pi discovery currently supports macOS and Linux."],
            };
        }

        const table = await this.processes();
        const deadline = Date.now() + 8000;
        const sessions: ActivePi[] = [];
        const warnings: string[] = [];

        for (const socket of await this.sockets()) {
            if (Date.now() >= deadline) {
                warnings.push(
                    "Herdr discovery timed out before all sessions could be checked. Refresh to try again.",
                );
                break;
            }

            try {
                const { snapshot } = await this.request<{ snapshot: Snapshot }>(
                    socket,
                    "session.snapshot",
                );

                if (!Array.isArray(snapshot?.panes) || snapshot.panes.length > 500) {
                    throw new Error("Invalid Herdr snapshot");
                }

                for (const pane of snapshot.panes.filter((item) => item.agent === "pi")) {
                    if (Date.now() >= deadline) {
                        throw new Error("Discovery deadline");
                    }

                    const reference = pane.agent_session;
                    const candidate: Omit<ActivePi, "id"> = {
                        socket,
                        pane: pane.pane_id,
                        path: reference?.value ?? "",
                        title: pane.label || "Pi session",
                        cwd: pane.foreground_cwd || pane.cwd || "",
                        location:
                            snapshot.workspaces?.find(
                                (item) => item.workspace_id === pane.workspace_id,
                            )?.label || pane.pane_id,
                        state: pane.agent_status,
                    };

                    if (
                        reference?.agent !== "pi" ||
                        reference.source !== "herdr:pi" ||
                        reference.kind !== "path" ||
                        typeof candidate.path !== "string" ||
                        !isAbsolute(candidate.path)
                    ) {
                        candidate.path = "";
                        candidate.reason =
                            "Pi has not reported its session file. Enable Herdr's Pi integration and reload Pi.";
                    } else {
                        const { process_info: info } = await this.request<{
                            process_info: ProcessInfo;
                        }>(socket, "pane.process_info", { pane_id: pane.pane_id });
                        const actual = foregroundPi(table, info);

                        if (!actual) {
                            candidate.reason =
                                "Cannot identify a separate local Pi process safely.";
                        } else {
                            candidate.process = {
                                pid: actual.pid,
                                parent: actual.parent,
                                uid: actual.uid,
                                started: actual.started,
                                commandHash: actual.commandHash,
                            };
                            const file = await stat(candidate.path).catch(() => undefined);

                            if (!file?.isFile()) {
                                candidate.reason =
                                    "The reported Pi session file is unavailable. Refresh its session reference.";
                            }
                        }
                    }

                    sessions.push({ id: idFor(candidate), ...candidate });
                }
            } catch {
                warnings.push(
                    `Could not inspect Herdr at ${socket}. Check that it is running and supports pane.process_info.`,
                );
            }
        }

        for (const session of sessions) {
            if (
                sessions.some(
                    (item) =>
                        item !== session &&
                        ((session.path && item.path === session.path) ||
                            (item.socket === session.socket && item.pane === session.pane) ||
                            (session.process && item.process?.pid === session.process.pid)),
                )
            ) {
                session.reason =
                    "More than one Pi reports the same source process, pane or session file. Resolve the duplicate and refresh.";
            }
        }

        return { sessions, warnings };
    }

    async find(id: string): Promise<ActivePi> {
        const result = await this.list();

        if (result.warnings.length) {
            throw new HttpError(
                409,
                "Could not inspect every local Herdr session. Resolve the discovery warnings and refresh before copying Pi.",
            );
        }

        const session = result.sessions.find((item) => item.id === id);

        if (!session) {
            throw new HttpError(409, "This Pi session changed or exited. Refresh the list.");
        }

        if (session.reason) {
            throw new HttpError(409, session.reason);
        }

        return session;
    }
}
