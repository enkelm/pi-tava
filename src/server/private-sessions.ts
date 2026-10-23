/** Owner-only live Herdr mirror. Herdr owns these processes; private views never become Durable conversations. */
import { createHash, randomUUID } from "node:crypto";
import { statSync } from "node:fs";
import type { IncomingMessage } from "node:http";
import { basename, dirname, isAbsolute } from "node:path";
import { stripVTControlCharacters } from "node:util";
import type { PocketApp } from "./app.ts";
import { gitDirOf, headOf } from "./branches.ts";
import type { User } from "./config.ts";
import { HttpError } from "./errors.ts";
import { foregroundPi, type ProcessIdentity, type ProcessInfo } from "./pi-sessions/herdr.ts";
import { readJournal } from "./private-sessions/journal.ts";
import { PrivateControl, UNCERTAIN_INPUT_REASON } from "./private-sessions/control.ts";
import { HerdrAlerts, privatePaneId, type HerdrAlertSink } from "./private-sessions/alerts.ts";
import { MAX_ATTACHMENTS, PrivateUploads, uploadId } from "./private-sessions/uploads.ts";
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
type WireWorkspace = WireGroup & {
    worktree?: unknown;
    branch?: unknown;
    active_tab_id?: unknown;
    agent_status?: unknown;
    custom_label?: unknown;
};
type Snapshot = { panes: WirePane[]; workspaces: WireWorkspace[]; tabs?: WireGroup[] };
export type PrivatePane = {
    id: string;
    nativeId: string;
    title: string;
    cwd: string;
    agent?: string;
    state: string;
};
type Tab = { id: string; nativeId?: string; label: string; active?: boolean; panes: PrivatePane[] };
type Workspace = {
    id: string;
    nativeId?: string;
    label: string;
    tabs: Tab[];
    worktree?: { key: string; label: string; isLinkedWorktree: boolean };
    branch?: string;
    state?: string;
    customLabel?: boolean;
};
type Instance = {
    id: string;
    label: string;
    available: boolean;
    error?: string;
    workspaces: Workspace[];
};
type Target = { socket: string; wire: WirePane; pane: PrivatePane };
export type PrivateRequest = {
    revision?: unknown;
    text?: unknown;
    requestId?: unknown;
    attachments?: unknown;
};
const hash = (value: unknown) => createHash("sha256").update(JSON.stringify(value)).digest("hex");
const unsafeText = /[\u0000-\u001f\u007f-\u009f\u200e\u200f\u2028-\u202e\u2066-\u2069]/;

const label = (value: unknown, fallback: string) => {
    const text =
        typeof value === "string"
            ? stripVTControlCharacters(value).replace(new RegExp(unsafeText, "g"), "").slice(0, 400)
            : "";

    return text.trim() ? text : fallback;
};

const validId = (value: unknown): value is string =>
    typeof value === "string" && value.length > 0 && value.length <= 256;
const exactText = (value: unknown, maximum: number): string | undefined =>
    typeof value === "string" && value.trim() && value.length <= maximum && !unsafeText.test(value)
        ? value
        : undefined;
const record = (value: unknown): Record<string, unknown> | undefined =>
    value && typeof value === "object" && !Array.isArray(value)
        ? (value as Record<string, unknown>)
        : undefined;

function worktreeOf(value: unknown): Workspace["worktree"] {
    const row = record(value);
    // Identity is never truncated or rewritten: distinct repositories must stay distinct.
    const key = exactText(row?.repo_key, 4096);
    const title = label(row?.repo_name, "");

    return key && title && typeof row?.is_linked_worktree === "boolean"
        ? { key, label: title, isLinkedWorktree: row.is_linked_worktree }
        : undefined;
}

/** JSON snapshots currently omit branch. Read HEAD only for the list, never for prompt/detail scans. */
function addBranches(workspaces: Workspace[], snapshot: Snapshot): void {
    const paths = new Map<string, unknown[]>();
    const cache = new Map<string, string | undefined>();

    for (const row of snapshot.workspaces) {
        paths.set(row.workspace_id!, [record(row.worktree)?.checkout_path]);
    }

    for (const pane of snapshot.panes) {
        const parent = validId(pane.workspace_id) ? pane.workspace_id : "unassigned";
        const candidates = paths.get(parent) ?? [];

        candidates.push(pane.foreground_cwd, pane.cwd);
        paths.set(parent, candidates);
    }

    for (const workspace of workspaces) {
        if (workspace.branch) {
            continue;
        }

        for (const candidate of paths.get(workspace.nativeId ?? "unassigned") ?? []) {
            const path = exactText(candidate, 4096);

            if (!path || !isAbsolute(path)) {
                continue;
            }

            if (!cache.has(path)) {
                let branch: string | undefined;

                try {
                    if (statSync(path).isDirectory()) {
                        const gitDir = gitDirOf(path);
                        const head = gitDir ? headOf(gitDir) : undefined;

                        branch = head && "branch" in head ? exactText(head.branch, 400) : undefined;
                    }
                } catch {
                    // Missing or unreadable optional paths do not make the instance unavailable.
                }

                cache.set(path, branch);
            }

            const branch = cache.get(path);

            if (branch) {
                workspace.branch = branch;
                break;
            }
        }
    }
}

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
    const activeTabs = new Map<string, string>();

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

        const group = workspace(row.workspace_id, row.label);
        const worktree = worktreeOf(row.worktree);
        const branch = exactText(row.branch, 400);
        const activeTab = exactText(row.active_tab_id, 256);

        if (worktree) {
            group.worktree = worktree;
        }

        if (branch) {
            group.branch = branch;
        }

        if (activeTab) {
            activeTabs.set(row.workspace_id, activeTab);
        }

        if (
            typeof row.agent_status === "string" &&
            ["idle", "working", "blocked", "done", "unknown"].includes(row.agent_status)
        ) {
            group.state = row.agent_status;
        }

        if (typeof row.custom_label === "boolean") {
            group.customLabel = row.custom_label;
        }
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

        const id = privatePaneId(socket, wire.pane_id);

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

    for (const [parent, activeTab] of activeTabs) {
        for (const group of groups.get(parent)!.tabs) {
            group.active = group.nativeId === activeTab;
        }
    }

    return { workspaces: [...groups.values()], targets };
}

export class PrivateSessions {
    readonly #app: PocketApp;
    readonly #epoch = randomUUID();
    readonly #requests = new Map<string, { digest: string; promise: Promise<{ sent: true }> }>();
    readonly control: PrivateControl;
    readonly #uploads: PrivateUploads;
    #alerts: HerdrAlerts | undefined;
    #closed = false;

    constructor(app: PocketApp) {
        this.#app = app;
        this.#uploads = new PrivateUploads(() => app.dataDir);
        this.control = new PrivateControl(app);
        this.local.control = this.control;
    }

    get local() {
        // One transport, process checker and pane-operation lock for private input and adoption.
        return this.#app.piSessions.active.local;
    }

    /** Start once after push/owner configuration is ready. Alerts supplies its owner-only delivery sink. */
    startAlerts(notify: HerdrAlertSink): void {
        if (this.#closed) {
            return;
        }

        this.#alerts ??= new HerdrAlerts(
            this.local,
            () => {
                const owner = this.#app.config.users.find((user) => user.role === "owner");
                const store = this.#app.pushStore;

                if (!owner || !store) {
                    return undefined;
                }

                const prefs = store.prefs(owner.id);

                return (prefs.done || prefs.approval) && store.subscriptions(owner.id).length
                    ? owner
                    : undefined;
            },
            notify,
        );
        this.#alerts.start();
    }

    /** Stop polling, cancel native reads and join their actual transport/child cleanup. */
    async close(): Promise<void> {
        this.#closed = true;
        await this.#alerts?.close();
    }

    #owner(user: User): void {
        if (user.role !== "owner" || this.#app.config.userById(user.id)?.role !== "owner") {
            throw new HttpError(403, "Only the owner can access private Herdr sessions");
        }
    }

    async #scan(readBranches = false) {
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

                    if (readBranches) {
                        addBranches(tree.workspaces, snapshot);
                    }

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
        const { instances, warnings } = await this.#scan(true);

        this.#owner(user);

        return { instances, warnings };
    }

    /** Terminal gateway only: socket must come from terminalTarget, never a browser-supplied path.
     * Await once before the first mutating native input/request, inside local.withTerminalInput.
     * Known terminal use does not block import or fresh guarded Chat. Mutating input is excluded during takeover.
     * Detach and write completion are not PTY drain acknowledgements; uncertain Chat receipts remain separate.
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
        let importReason = reason;

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
                    importReason = !sessionPath(target.wire)
                        ? "Pi has not reported its current session. Enable Herdr's Pi integration first."
                        : !["idle", "done", "working", "blocked"].includes(target.pane.state)
                          ? "Pi's status is unknown. Refresh before importing."
                          : "";
                }
            } catch {
                // Read access is still useful if a Herdr version cannot verify foreground processes.
            }
        }

        const inputReason = await this.local.inputReason(target.socket, target.wire.pane_id);

        reason = inputReason ?? reason;

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
        let model: { provider: string; modelId: string } | undefined;
        let terminal = "";
        const path = sessionPath(target.wire);

        if (path && inspected.identity) {
            try {
                const journal = await readJournal(path);

                entries = journal.entries;
                model = journal.model;
                warnings.push(...journal.warnings);
            } catch {
                warnings.push(
                    "Saved Pi history is unavailable or unsupported. Use the terminal view; no source file was changed.",
                );
            }
        }

        try {
            // Polling must be passive. Herdr recent/recent_unwrapped reads may send
            // wheel events to harvest an idle alternate-screen agent's history.
            const { read } = await this.local.request<{ read: { pane_id: string; text: string } }>(
                target.socket,
                "pane.read",
                {
                    pane_id: target.wire.pane_id,
                    source: "visible",
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
            model,
            terminal,
            warnings,
            canPrompt: !current.reason,
            ...(current.reason ? { reason: current.reason } : {}),
            canImport: Boolean(path && current.identity && !current.importReason),
            ...(current.importReason ? { importReason: current.importReason } : {}),
            capturedAt: Date.now(),
        };
    }

    async #verifyPrompt(user: User, id: string, revision: string) {
        this.#owner(user);
        const target = await this.#target(id);
        const inspected = await this.#inspect(target);

        this.#owner(user);

        if (inspected.revision !== revision) {
            throw new HttpError(
                409,
                "This Pi process or session changed. Refresh and review it before sending.",
            );
        }

        if (inspected.reason) {
            throw new HttpError(409, inspected.reason);
        }

        return target;
    }

    async upload(
        user: User,
        id: string,
        revision: unknown,
        name: unknown,
        request: IncomingMessage,
    ) {
        this.#owner(user);

        if (typeof revision !== "string" || !/^[a-f0-9]{64}$/.test(revision)) {
            throw new HttpError(400, "Upload from the current private pane revision");
        }

        await this.#verifyPrompt(user, id, revision);

        // Uploads send no external input and may stream concurrently. A takeover or replacement
        // invalidates the post-stream revision check and the resulting token's later prompt guard.
        return this.#uploads.store(
            { user: user.id, pane: id, revision },
            name,
            request,
            async () => {
                await this.#verifyPrompt(user, id, revision);
            },
        );
    }

    async deleteUpload(user: User, id: string, token: unknown) {
        this.#owner(user);

        if (!/^[a-f0-9]{64}$/.test(id)) {
            throw new HttpError(400, "Select a pane from Private");
        }

        // No Herdr lookup: the owner can discard an unsubmitted file even after its pane closes.
        return this.#uploads.remove(user.id, id, token);
    }

    prompt(user: User, id: string, request: PrivateRequest): Promise<{ sent: true }> {
        this.#owner(user);

        if (
            request &&
            typeof request.text === "string" &&
            (/^!/.test(request.text.trimStart()) || /[\n\r\u2028\u2029\t]/.test(request.text))
        ) {
            throw new HttpError(
                400,
                "Use Terminal mode for shell commands, tabs or multiline input. Chat accepts a single-line prompt; bracketed paste is not verified.",
            );
        }

        if (
            !request ||
            typeof request !== "object" ||
            typeof request.revision !== "string" ||
            !/^[a-f0-9]{64}$/.test(request.revision) ||
            (request.text !== undefined && typeof request.text !== "string") ||
            Buffer.byteLength(request.text ?? "") > 32 * 1024 ||
            unsafeText.test(request.text ?? "") ||
            typeof request.requestId !== "string" ||
            !/^[a-zA-Z0-9_-]{1,128}$/.test(request.requestId)
        ) {
            throw new HttpError(
                400,
                "Send a plain-text message of up to 32 KiB from the current private pane",
            );
        }

        const text = (request.text ?? "") as string;
        const attachments = request.attachments === undefined ? [] : request.attachments;

        if (
            !Array.isArray(attachments) ||
            attachments.length > MAX_ATTACHMENTS ||
            !attachments.every(uploadId) ||
            new Set(attachments).size !== attachments.length ||
            (!text.trim() && !attachments.length)
        ) {
            throw new HttpError(400, "Send text or up to 10 private attachment tokens, not paths");
        }

        if (attachments.length && text.trimStart().startsWith("/")) {
            throw new HttpError(
                400,
                "Send slash commands without attachments; your files are kept for the next message",
            );
        }

        const [command, ...args] = text.trim().split(/\s+/);
        const argument = args.join(" ");

        if (
            [
                "/settings",
                "/tree",
                "/scoped-models",
                "/fork",
                "/trust",
                "/login",
                "/logout",
                "/resume",
                "/import",
                "/bug",
            ].includes(command ?? "") ||
            (["/model", "/thinking", "/name"].includes(command ?? "") && !argument) ||
            (command === "/thinking" &&
                !["off", "minimal", "low", "medium", "high", "xhigh", "max"].includes(
                    argument.toLowerCase(),
                ))
        ) {
            throw new HttpError(
                400,
                "Use Terminal mode for Pi dialogs. In Chat, /model and /name need arguments and /thinking needs an explicit valid level.",
            );
        }

        const key = `${user.id}:${request.requestId}`;
        const digest = hash([id, request.revision, text, attachments]);
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

        const promise = this.#send(user, id, {
            revision: request.revision,
            text,
            attachments,
        });

        this.#requests.set(key, { digest, promise });

        return promise;
    }

    async #send(
        user: User,
        id: string,
        request: { revision: string; text: string; attachments: string[] },
    ): Promise<{ sent: true }> {
        const first = await this.#target(id);

        return this.local.withPane(
            first.socket,
            first.wire.pane_id,
            async () => {
                const target = await this.#verifyPrompt(user, id, request.revision);
                const scope = { user: user.id, pane: id, revision: request.revision };
                const paths = this.#uploads.paths(scope, request.attachments);
                const text = paths.length
                    ? `${request.text.trim() ? request.text + " " : ""}Attached files (use read on these paths, including images): ${JSON.stringify(paths)}`
                    : request.text;

                if (Buffer.byteLength(text) > 32 * 1024 || unsafeText.test(text)) {
                    throw new HttpError(
                        400,
                        "The message including attachment paths must be a safe single line of up to 32 KiB",
                    );
                }

                await this.#uploads.retain(scope, request.attachments);
                this.#owner(user);
                const receipt = await this.control.admitPrompt(target.socket, target.wire.pane_id);

                try {
                    this.#owner(user);
                    // No raw-input fallback or wait:false. Herdr's timeout cannot cancel its queued Enter.
                    // This is not a PID-bound channel: external clients/process exits can still race submission.
                    const ack = await this.local.request(
                        target.socket,
                        "agent.prompt",
                        { target: target.wire.pane_id, text },
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

        return this.#app.piSessions.active.preview(user, { id: session.id });
    }
}
