/** Owner-only live Herdr mirror. Herdr owns these processes; private views never become Durable conversations. */
import { createHash, randomUUID } from "node:crypto";
import { basename, dirname, isAbsolute } from "node:path";
import { stripVTControlCharacters } from "node:util";
import type { PocketApp } from "./app.ts";
import type { User } from "./config.ts";
import { HttpError } from "./errors.ts";
import { foregroundPi, type ProcessIdentity, type ProcessInfo } from "./imports/herdr.ts";
import { readJournal } from "./private-sessions/journal.ts";
import { PrivateControl, UNCERTAIN_INPUT_REASON } from "./private-sessions/control.ts";
import type { ClientEntry } from "./projection.ts";

// Wire hierarchy and pane.read contract adapted from Collie bridge/mux/herdr/client.ts
// cfaf95a93df3c9404a03f5f840bf222f0cd6c2ee, MIT (LICENSES/Collie-MIT.txt).
type WirePane = {
    pane_id: string;
    workspace_id?: string;
    tab_id?: string;
    terminal_id?: string;
    label?: string;
    terminal_title_stripped?: string;
    terminal_title?: string;
    cwd?: string;
    foreground_cwd?: string;
    agent?: string;
    agent_status?: string;
    agent_session?: { agent?: string; source?: string; kind?: string; value?: string };
};
type WireGroup = { workspace_id?: string; tab_id?: string; label?: string; number?: number };
type Snapshot = { panes: WirePane[]; workspaces: WireGroup[]; tabs?: WireGroup[] };
export type PrivatePane = {
    id: string;
    nativeId: string;
    title: string;
    cwd: string;
    agent?: string;
    state: string;
};
type Tab = { id: string; nativeId?: string; label: string; panes: PrivatePane[] };
type Workspace = { id: string; nativeId?: string; label: string; tabs: Tab[] };
type Instance = {
    id: string;
    label: string;
    available: boolean;
    error?: string;
    workspaces: Workspace[];
};
type Target = { socket: string; wire: WirePane; pane: PrivatePane };
export type PrivateRequest = { revision?: unknown; text?: unknown; requestId?: unknown };
const hash = (value: unknown) => createHash("sha256").update(JSON.stringify(value)).digest("hex");
const label = (value: unknown, fallback: string) =>
    typeof value === "string" && value.trim()
        ? stripVTControlCharacters(value).slice(0, 400)
        : fallback;
const validId = (value: unknown): value is string =>
    typeof value === "string" && value.length > 0 && value.length <= 256;

function sessionPath(wire: WirePane): string | undefined {
    const ref = wire.agent_session;

    return wire.agent === "pi" &&
        ref?.agent === "pi" &&
        ref.source === "herdr:pi" &&
        ref.kind === "path" &&
        typeof ref.value === "string" &&
        isAbsolute(ref.value)
        ? ref.value
        : undefined;
}

function hierarchy(socket: string, snapshot: Snapshot) {
    if (
        !Array.isArray(snapshot?.panes) ||
        !Array.isArray(snapshot.workspaces) ||
        snapshot.panes.length > 1000 ||
        snapshot.workspaces.length > 500 ||
        (snapshot.tabs !== undefined &&
            (!Array.isArray(snapshot.tabs) || snapshot.tabs.length > 1000))
    ) {
        throw new Error("Unsupported Herdr snapshot");
    }

    const targets = new Map<string, Target>();
    const groups = new Map<string, Workspace>();
    const tabs = new Map<string, Tab>();

    const workspace = (id: string, title?: string): Workspace => {
        let group = groups.get(id);

        if (!group) {
            group = {
                id: hash([socket, "workspace", id]),
                ...(id === "unassigned" ? {} : { nativeId: id }),
                label: label(title, "Workspace"),
                tabs: [],
            };
            groups.set(id, group);
        }

        return group;
    };

    const tab = (parent: string, id: string, title?: string): Tab => {
        const key = JSON.stringify([parent, id]);
        let group = tabs.get(key);

        if (!group) {
            group = {
                id: hash([socket, "tab", parent, id]),
                ...(id === "unassigned" ? {} : { nativeId: id }),
                label: label(title, "Tab"),
                panes: [],
            };
            tabs.set(key, group);
            workspace(parent).tabs.push(group);
        }

        return group;
    };

    for (const row of snapshot.workspaces) {
        if (!row || !validId(row.workspace_id)) {
            throw new Error("Invalid workspace");
        }

        workspace(row.workspace_id, row.label);
    }

    for (const row of snapshot.tabs ?? []) {
        if (!row || !validId(row.workspace_id) || !validId(row.tab_id)) {
            throw new Error("Invalid tab");
        }

        tab(row.workspace_id, row.tab_id, row.label);
    }

    for (const wire of snapshot.panes) {
        if (!wire || !validId(wire.pane_id)) {
            throw new Error("Invalid pane");
        }

        const id = hash([socket, "pane", wire.pane_id]);

        if (targets.has(id)) {
            throw new Error("Duplicate pane");
        }

        const pane: PrivatePane = {
            id,
            nativeId: wire.pane_id,
            title: label(
                wire.label,
                label(
                    wire.terminal_title_stripped,
                    label(wire.terminal_title, label(wire.agent, "Shell")),
                ),
            ),
            cwd: label(wire.foreground_cwd, label(wire.cwd, "")),
            ...(typeof wire.agent === "string" && wire.agent ? { agent: wire.agent } : {}),
            state: label(wire.agent_status, wire.agent ? "unknown" : "shell"),
        };
        const parent = validId(wire.workspace_id) ? wire.workspace_id : "unassigned";

        tab(parent, validId(wire.tab_id) ? wire.tab_id : "unassigned", "Other panes").panes.push(
            pane,
        );
        targets.set(id, { socket, wire, pane });
    }

    return { workspaces: [...groups.values()], targets };
}

export class PrivateSessions {
    readonly #app: PocketApp;
    readonly #epoch = randomUUID();
    readonly #requests = new Map<string, { digest: string; promise: Promise<{ sent: true }> }>();
    readonly control: PrivateControl;

    constructor(app: PocketApp) {
        this.#app = app;
        this.control = new PrivateControl(app);
        this.local.control = this.control;
    }

    get local() {
        // One transport, process checker and pane-operation lock for private input and adoption.
        return this.#app.imports.active.local;
    }

    #owner(user: User): void {
        if (user.role !== "owner" || this.#app.config.userById(user.id)?.role !== "owner") {
            throw new HttpError(403, "Only the owner can access private Herdr sessions");
        }
    }

    async #scan() {
        const sockets = [...new Set(await this.local.sockets())].slice(0, 33);
        const targets = new Map<string, Target>();
        const instances: Instance[] = await Promise.all(
            sockets.map(async (socket) => {
                const id = hash([socket, "instance"]);
                const directory = dirname(socket);
                const name =
                    basename(dirname(directory)) === "sessions"
                        ? basename(directory)
                        : "Default Herdr";

                try {
                    const { snapshot } = await this.local.request<{ snapshot: Snapshot }>(
                        socket,
                        "session.snapshot",
                    );
                    const tree = hierarchy(socket, snapshot);

                    for (const [key, target] of tree.targets) {
                        targets.set(key, target);
                    }

                    return { id, label: name, available: true, workspaces: tree.workspaces };
                } catch {
                    return {
                        id,
                        label: name,
                        available: false,
                        error: "Herdr is unavailable or its snapshot is unsupported. Refresh to reconnect.",
                        workspaces: [],
                    };
                }
            }),
        );

        return {
            instances,
            targets,
            warnings: instances.some((instance) => !instance.available)
                ? [
                      "Some Herdr instances could not be reached. Their previous contents are not shown.",
                  ]
                : [],
        };
    }

    async list(user: User) {
        this.#owner(user);
        const { instances, warnings } = await this.#scan();

        this.#owner(user);

        return { instances, warnings };
    }

    /** Terminal gateway only: socket must come from terminalTarget, never a browser-supplied path.
     * Await once before the first mutating native input/request, inside local.withTerminalInput.
     * Keep the instance lease for the child lifetime. It blocks takeover, not fresh guarded Chat.
     * Detach and write completion are not PTY drain acknowledgements; the takeover fence has no timeout or cleanup.
     */
    async markTerminalInput(user: User, socket: string): Promise<void> {
        this.#owner(user);
        await this.control.markTerminalInput(socket);
    }

    /** Server-resolved JSON socket and current terminal identity. Shells and every agent are allowed.
     * Authorization precedes all discovery I/O; terminal reads do not acquire the prompt/takeover lock.
     */
    async terminalTarget(
        user: User,
        id: string,
    ): Promise<{
        socket: string;
        pane: string;
        terminal: string;
        instanceId: string;
    }> {
        this.#owner(user);
        const target = await this.#target(id);

        this.#owner(user);

        if (!validId(target.wire.terminal_id) || basename(target.socket) !== "herdr.sock") {
            throw new HttpError(
                409,
                "This pane has no supported terminal target. Refresh Private.",
            );
        }

        return {
            socket: target.socket,
            pane: target.wire.pane_id,
            terminal: target.wire.terminal_id,
            instanceId: hash([target.socket, "instance"]),
        };
    }

    async #target(id: string): Promise<Target> {
        if (!/^[a-f0-9]{64}$/.test(id)) {
            throw new HttpError(400, "Select a pane from Private");
        }

        const scan = await this.#scan();
        const target = scan.targets.get(id);

        if (!target) {
            throw new HttpError(
                scan.warnings.length ? 503 : 404,
                scan.warnings.length
                    ? "Herdr could not be reached. Refresh before using this pane."
                    : "This pane closed or moved. Select it again from Private.",
            );
        }

        return target;
    }

    async #inspect(target: Target) {
        let identity: ProcessIdentity | undefined;
        let reason =
            target.wire.agent === "pi"
                ? "Cannot verify this Pi process. Chat prompts are disabled; use Terminal mode."
                : "Chat prompts currently support only Pi. Use Terminal mode for this pane.";

        if (target.wire.agent === "pi") {
            try {
                const [{ process_info }, table] = await Promise.all([
                    this.local.request<{ process_info: ProcessInfo }>(
                        target.socket,
                        "pane.process_info",
                        { pane_id: target.wire.pane_id },
                    ),
                    this.local.processes(),
                ]);
                const process = foregroundPi(table, process_info);

                if (process) {
                    const { pid, parent, uid, started, commandHash } = process;

                    identity = { pid, parent, uid, started, commandHash };
                    reason = !sessionPath(target.wire)
                        ? "Pi has not reported its current session. Enable Herdr's Pi integration first."
                        : !["idle", "done"].includes(target.pane.state)
                          ? "Pi is working or waiting for input. Finish this turn in Herdr before sending another message."
                          : "";
                }
            } catch {
                // Read access is still useful if a Herdr version cannot verify foreground processes.
            }
        }

        reason =
            (await this.local.inputReason(target.socket, target.wire.pane_id, "prompt")) ?? reason;
        const importReason =
            (await this.local.inputReason(target.socket, target.wire.pane_id, "takeover")) ??
            reason;

        const revision = hash([
            this.#epoch,
            target.pane.id,
            target.wire.terminal_id,
            target.wire.agent,
            sessionPath(target.wire),
            identity,
        ]);

        return { identity, reason, importReason, revision };
    }

    async pane(user: User, id: string) {
        this.#owner(user);
        const target = await this.#target(id);
        const inspected = await this.#inspect(target);
        const warnings: string[] = [];
        let entries: ClientEntry[] = [];
        let terminal = "";
        const path = sessionPath(target.wire);

        if (path && inspected.identity) {
            try {
                const journal = await readJournal(path);

                entries = journal.entries;
                warnings.push(...journal.warnings);
            } catch {
                warnings.push(
                    "Saved Pi history is unavailable or unsupported. Use the terminal view; no source file was changed.",
                );
            }
        }

        try {
            // Collie's plain-text read contract: recent_unwrapped is the WIRE spelling, not recent-unwrapped.
            const { read } = await this.local.request<{ read: { pane_id: string; text: string } }>(
                target.socket,
                "pane.read",
                {
                    pane_id: target.wire.pane_id,
                    source: "recent_unwrapped",
                    lines: 200,
                    format: "text",
                },
            );

            if (read?.pane_id !== target.wire.pane_id || typeof read.text !== "string") {
                throw new Error("Invalid pane read");
            }

            terminal = stripVTControlCharacters(read.text).slice(-64 * 1024);
        } catch {
            warnings.push("Live terminal output is unavailable. Refresh to try again.");
        }

        const current = await this.#inspect(await this.#target(id));

        this.#owner(user);

        if (current.revision !== inspected.revision) {
            throw new HttpError(
                409,
                "The pane's agent changed while loading. Refresh before using it.",
            );
        }

        return {
            pane: target.pane,
            revision: inspected.revision,
            entries,
            terminal,
            warnings,
            canPrompt: !current.reason,
            ...(current.reason ? { reason: current.reason } : {}),
            canImport: Boolean(
                path &&
                current.identity &&
                ["idle", "done"].includes(target.pane.state) &&
                !current.importReason,
            ),
            ...(current.importReason ? { importReason: current.importReason } : {}),
            capturedAt: Date.now(),
        };
    }

    prompt(user: User, id: string, request: PrivateRequest): Promise<{ sent: true }> {
        this.#owner(user);

        if (
            request &&
            typeof request.text === "string" &&
            (/^[\/!]/.test(request.text.trimStart()) || /[\n\r\u2028\u2029\t]/.test(request.text))
        ) {
            throw new HttpError(
                400,
                "Use Terminal mode for commands, tabs or multiline input. Chat accepts a single plain-text prompt; bracketed paste is not verified.",
            );
        }

        if (
            !request ||
            typeof request !== "object" ||
            typeof request.revision !== "string" ||
            !/^[a-f0-9]{64}$/.test(request.revision) ||
            typeof request.text !== "string" ||
            !request.text.trim() ||
            Buffer.byteLength(request.text) > 32 * 1024 ||
            /[\u0000-\u0008\u000b-\u001f\u007f]/.test(request.text) ||
            typeof request.requestId !== "string" ||
            !/^[a-zA-Z0-9_-]{1,128}$/.test(request.requestId)
        ) {
            throw new HttpError(
                400,
                "Send a plain-text message of up to 32 KiB from the current private pane",
            );
        }

        const key = `${user.id}:${request.requestId}`;
        const digest = hash([id, request.revision, request.text]);
        const previous = this.#requests.get(key);

        if (previous) {
            if (previous.digest !== digest) {
                throw new HttpError(
                    409,
                    "This request ID was already used for a different message",
                );
            }

            return previous.promise;
        }

        // Do not evict requests within this epoch. Durable admissions fence unresolved sends across restart.
        if (this.#requests.size >= 4096) {
            throw new HttpError(
                503,
                "This app run reached its private prompt limit. Restart to reset the request limit; uncertain input blocks will remain.",
            );
        }

        const promise = this.#send(user, id, request as { revision: string; text: string });

        this.#requests.set(key, { digest, promise });

        return promise;
    }

    async #send(
        user: User,
        id: string,
        request: { revision: string; text: string },
    ): Promise<{ sent: true }> {
        const first = await this.#target(id);

        return this.local.withPane(
            first.socket,
            first.wire.pane_id,
            async () => {
                const target = await this.#target(id);
                const inspected = await this.#inspect(target);

                this.#owner(user);

                if (inspected.revision !== request.revision) {
                    throw new HttpError(
                        409,
                        "This Pi process or session changed. Refresh and review it before sending.",
                    );
                }

                if (inspected.reason) {
                    throw new HttpError(409, inspected.reason);
                }

                const receipt = await this.control.admitPrompt(target.socket, target.wire.pane_id);

                try {
                    this.#owner(user);
                    // No raw-input fallback or wait:false. Herdr's timeout cannot cancel its queued Enter.
                    // This is not a PID-bound channel: external clients/process exits can still race submission.
                    const ack = await this.local.request(
                        target.socket,
                        "agent.prompt",
                        { target: target.wire.pane_id, text: request.text },
                        7000,
                    );

                    await this.control.settlePrompt(receipt, ack);

                    return { sent: true };
                } catch {
                    // Admission already persisted. Errors, malformed acknowledgements and commit failures all stay fenced.
                    throw new HttpError(
                        503,
                        `Herdr did not confirm delivery. ${UNCERTAIN_INPUT_REASON}`,
                    );
                }
            },
            "prompt",
        );
    }

    async importPreview(user: User, id: string, request: PrivateRequest) {
        this.#owner(user);
        const target = await this.#target(id);
        const inspected = await this.#inspect(target);

        if (!request || request.revision !== inspected.revision) {
            throw new HttpError(409, "This Pi changed. Refresh before importing.");
        }

        await this.local.requireInputSafe(target.socket, target.wire.pane_id);
        const found = await this.local.list();
        const session = found.sessions.find(
            (item) =>
                item.socket === target.socket &&
                item.pane === target.wire.pane_id &&
                item.path === sessionPath(target.wire) &&
                item.process?.pid === inspected.identity?.pid,
        );

        if (!session) {
            throw new HttpError(409, "This pane does not have an importable Pi session");
        }

        this.#owner(user);

        return this.#app.imports.active.preview(user, { id: session.id });
    }
}
