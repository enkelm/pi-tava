/** Local Herdr discovery and a guarded stop of one Pi process, never its pane or shell. */
import { AsyncLocalStorage } from "node:async_hooks";
import { execFile } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { lstat, readdir, stat } from "node:fs/promises";
import { createConnection } from "node:net";
import { homedir } from "node:os";
import { basename, dirname, isAbsolute, join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { promisify } from "node:util";
import { HttpError } from "../errors.ts";
import {
    TERMINAL_HELD_REASON,
    type ControlPurpose,
    type PrivateControl,
} from "../private-sessions/control.ts";

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
): Promise<T> {
    return new Promise((resolve, reject) => {
        const socket = createConnection(socketPath);
        const id = randomUUID();
        let text = "";
        let finished = false;

        const finish = (error?: Error, result?: T) => {
            if (finished) {
                return;
            }

            finished = true;
            clearTimeout(timer);
            socket.destroy();

            if (error) {
                reject(error);
            } else {
                resolve(result!);
            }
        };

        const timer = setTimeout(() => finish(new Error("Herdr did not respond")), timeoutMs);

        socket.setEncoding("utf8");
        socket.on("error", (error) => finish(error));
        socket.on("end", () => finish(new Error("Herdr closed before replying")));
        socket.on("connect", () => socket.write(`${JSON.stringify({ id, method, params })}\n`));
        socket.on("data", (chunk: string) => {
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

export async function localProcesses(): Promise<LocalProcess[]> {
    try {
        const { stdout } = await execute(
            "/bin/ps",
            ["-axo", "pid=,ppid=,uid=,stat=,lstart=,command="],
            {
                env: { ...process.env, LC_ALL: "C" },
                timeout: 3000,
                maxBuffer: 4 * 1024 * 1024,
            },
        );

        return parseProcesses(stdout);
    } catch {
        // Do not log ps output: unrelated process arguments may contain credentials.
        throw new HttpError(
            503,
            "Could not inspect local processes. Automatic takeover is unavailable.",
        );
    }
}

function sameProcess(a: ProcessIdentity, b: ProcessIdentity | undefined): boolean {
    return (
        b !== undefined &&
        a.pid === b.pid &&
        a.parent === b.parent &&
        a.uid === b.uid &&
        a.started === b.started &&
        a.commandHash === b.commandHash
    );
}

function sameLifetime(a: ProcessIdentity, b: ProcessIdentity | undefined): boolean {
    return b !== undefined && a.pid === b.pid && a.uid === b.uid && a.started === b.started;
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
async function sockets(): Promise<string[]> {
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
        const metadata = await lstat(path).catch(() => undefined);

        if (metadata?.isSocket() && metadata.uid === process.getuid?.()) {
            result.push(path);
        }
    }

    return result;
}

/** The same foreground identity check is used for imports and the private Pi bridge. No stop-policy checks here. */
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

type InputOperation = {
    socket: string;
    pane: string | undefined;
    purpose: ControlPurpose | "terminal";
};

/** Kept as a small concrete class so tests can replace OS/socket methods without touching real sessions. */
export class LocalPiSessions {
    processes = localProcesses;
    sockets = sockets;
    request = herdrRequest;
    signal = (pid: number) => process.kill(pid, "SIGTERM");
    stopTimeoutMs = 8000;
    /** Installed by PrivateSessions without reading storage during app construction. */
    control?: PrivateControl;
    readonly #operations = new Set<InputOperation>();
    readonly #operationContext = new AsyncLocalStorage<InputOperation>();
    readonly #instanceHolds = new Map<string, number>();

    async inputReason(
        socket: string,
        pane: string,
        purpose: ControlPurpose = "takeover",
    ): Promise<string | undefined> {
        const reason = await this.control?.reason(socket, pane, purpose);

        return (
            reason ??
            (purpose === "takeover" && this.#instanceHolds.has(socket)
                ? TERMINAL_HELD_REASON
                : undefined)
        );
    }

    async requireInputSafe(
        socket: string,
        pane: string,
        purpose: ControlPurpose = "takeover",
    ): Promise<void> {
        const reason = await this.inputReason(socket, pane, purpose);

        if (reason) {
            throw new HttpError(409, reason);
        }
    }

    /** Attach before spawning a terminal client; release only when its child has shut down.
     * This blocks takeover, not Chat or observation. Native writes require withTerminalInput separately.
     */
    holdInstance(socket: string): () => void {
        if (
            [...this.#operations].some(
                (item) => item.socket === socket && item.purpose === "takeover",
            )
        ) {
            throw new HttpError(409, "This Herdr instance has an import operation in progress.");
        }

        this.#instanceHolds.set(socket, (this.#instanceHolds.get(socket) ?? 0) + 1);
        let released = false;

        return () => {
            if (released) {
                return;
            }

            released = true;
            const remaining = (this.#instanceHolds.get(socket) ?? 1) - 1;

            if (remaining) {
                this.#instanceHolds.set(socket, remaining);
            } else {
                this.#instanceHolds.delete(socket);
            }
        };
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
            throw new HttpError(
                409,
                "This pane or Herdr instance already has an input or import operation in progress.",
            );
        }

        const reservation = { socket, pane, purpose };

        this.#operations.add(reservation);

        return reservation;
    }

    /** Reserve before awaiting durable admission and writing to the native child. Undefined pane is instance-wide.
     * Explicit terminal control ignores durable Chat uncertainty. It still cannot overlap an active Pocket
     * prompt, stop or conflicting native write. Release means the callback ended, not that Herdr drained its PTY.
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

    /** Serializes app bridge input with takeover and native writes, not the lifetime of an attached terminal.
     * Prompt callers opt into fresh Chat checks alongside known terminal use, never after uncertain Chat.
     */
    async withPane<T>(
        socket: string,
        pane: string,
        operation: () => Promise<T>,
        purpose: ControlPurpose = "takeover",
    ): Promise<T> {
        if (purpose === "takeover" && this.#instanceHolds.has(socket)) {
            throw new HttpError(409, TERMINAL_HELD_REASON);
        }

        // Reserve synchronously, before durable I/O, so a conflicting native write cannot slip across it.
        const reservation = this.#reserve(socket, pane, purpose);

        try {
            await this.requireInputSafe(socket, pane, purpose);

            return await this.#operationContext.run(reservation, operation);
        } finally {
            this.#operations.delete(reservation);
        }
    }

    async list(): Promise<{ sessions: ActivePi[]; warnings: string[] }> {
        if (process.platform !== "darwin" && process.platform !== "linux") {
            return {
                sessions: [],
                warnings: [
                    "Automatic takeover currently supports local Herdr sessions on macOS and Linux.",
                ],
            };
        }

        const table = await this.processes();
        const deadline = Date.now() + 8000;
        const sessions: ActivePi[] = [];
        const warnings: string[] = [];
        const protectedPids = new Set<number>([process.pid]);
        let ancestor = table.find((item) => item.pid === process.pid);

        while (ancestor) {
            protectedPids.add(ancestor.pid);
            const parent = table.find((item) => item.pid === ancestor!.parent);

            if (!parent || protectedPids.has(parent.pid)) {
                break;
            }

            ancestor = parent;
        }

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
                                "Cannot identify a separate local Pi process safely. Its shell will not be stopped.";
                        } else {
                            candidate.process = {
                                pid: actual.pid,
                                parent: actual.parent,
                                uid: actual.uid,
                                started: actual.started,
                                commandHash: actual.commandHash,
                            };
                            const file = await stat(candidate.path).catch(() => undefined);

                            if (protectedPids.has(actual.pid)) {
                                candidate.reason =
                                    "This Pi is an ancestor of the app or its inspection process. Start the app from a separate shell before moving it.";
                            } else if (
                                !file?.isFile() ||
                                file.mtimeMs < Date.parse(actual.started) - 1000
                            ) {
                                candidate.reason =
                                    "The session reference may be stale. Finish a turn in this Pi, then refresh.";
                            } else if (!["idle", "done"].includes(candidate.state)) {
                                candidate.reason =
                                    "Pi is working or waiting for input. Finish the current turn, then refresh.";
                            } else if (table.some((item) => item.parent === actual.pid)) {
                                candidate.reason =
                                    "Pi still has child processes. Finish or close its tools before moving it.";
                            }
                        }
                    }

                    const inputReason = await this.inputReason(socket, pane.pane_id);

                    if (inputReason) {
                        candidate.reason = inputReason;
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
            if (session.path && sessions.filter((item) => item.path === session.path).length > 1) {
                session.reason =
                    "More than one Pi reports this session file. Stop the duplicate before moving it.";
            }
        }

        return { sessions, warnings };
    }

    async find(id: string): Promise<ActivePi> {
        const result = await this.list();

        if (result.warnings.length) {
            throw new HttpError(
                409,
                "Could not inspect every local Herdr session. Resolve the discovery warnings and refresh before moving Pi.",
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

    /** Standalone stops also reserve the pane. ActiveImports already holds the same takeover reservation.
     * Async ownership lets that one caller reuse its lock without allowing unrelated callers to bypass it.
     */
    async stop(expected: ActivePi): Promise<void> {
        const owned = this.#operationContext.getStore();

        if (
            owned?.purpose === "takeover" &&
            owned.socket === expected.socket &&
            owned.pane === expected.pane &&
            this.#operations.has(owned)
        ) {
            return this.#stop(expected);
        }

        return this.withPane(expected.socket, expected.pane, () => this.#stop(expected));
    }

    /** Rechecks identity before SIGTERM; not an atomic OS process lease. No groups, keystrokes, or SIGKILL. */
    async #stop(expected: ActivePi): Promise<void> {
        if (
            !expected.process ||
            !Number.isSafeInteger(expected.process.pid) ||
            expected.process.pid <= 1
        ) {
            throw new HttpError(409, "No verified Pi process to stop");
        }

        const current = await this.find(expected.id);
        const table = await this.processes();

        if (
            !sameProcess(expected.process, current.process) ||
            !sameProcess(
                expected.process,
                table.find((item) => item.pid === expected.process!.pid),
            ) ||
            table.some((item) => item.parent === expected.process!.pid)
        ) {
            throw new HttpError(
                409,
                "The Pi process changed or started a tool. Refresh before moving it.",
            );
        }

        await this.requireInputSafe(expected.socket, expected.pane, "takeover");
        this.signal(expected.process.pid);
        const deadline = Date.now() + this.stopTimeoutMs;

        while (Date.now() < deadline) {
            const table = await this.processes();
            const current = table.find((item) => item.pid === expected.process!.pid);

            if (!sameLifetime(expected.process, current)) {
                return;
            }

            await delay(100);
        }

        throw new HttpError(
            409,
            "Pi did not exit after the stop request. It was not force-killed. Check its terminal, then retry.",
        );
    }

    async exited(expected: ActivePi): Promise<boolean> {
        const table = await this.processes();

        return (
            expected.process !== undefined &&
            !sameLifetime(
                expected.process,
                table.find((item) => item.pid === expected.process!.pid),
            )
        );
    }
}
