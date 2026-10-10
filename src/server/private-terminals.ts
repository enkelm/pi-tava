/** Owner-only structured Herdr connections. The native client owns protocol decoding; no terminal state is replayed. */
import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { createHash, randomBytes } from "node:crypto";
import { constants } from "node:fs";
import { access, lstat } from "node:fs/promises";
import type { IncomingMessage } from "node:http";
import { dirname, join } from "node:path";
import type { Duplex } from "node:stream";
import { WebSocket, WebSocketServer } from "ws";
import type { PocketApp } from "./app.ts";
import { Auth, COOKIE, origin, parseCookies } from "./auth.ts";
import { APP_ROOT, type User } from "./config.ts";
import { HttpError } from "./errors.ts";

const TICKET_MS = 30_000;
const MAX_CLIENTS = 4;
const MAX_LINE = 32 * 1024 * 1024;
const MAX_COMMAND = 24 * 1024 * 1024;
const MAX_QUEUE = 32 * 1024 * 1024;
const MAX_CELLS = 131_072;
const HELPER = join(APP_ROOT, "native", "herdr-web", "target", "release", "herdr-web");
const METHODS = new Set([
    "pane.focus",
    "pane.focus_direction",
    "pane.split",
    "pane.swap",
    "pane.zoom",
    "pane.resize",
    "pane.scroll",
    "pane.rename",
    "pane.close",
    "pane.clear",
    "pane.input.set",
    "pane.copy_motion",
    "pane.copy_search",
    "pane.selection.read",
    "pane.link.resolve",
    "layout.set_split_ratio",
    "tab.focus",
    "tab.create",
    "tab.move",
    "tab.rename",
    "tab.close",
    "workspace.focus",
    "workspace.create",
    "workspace.rename",
    "workspace.move_block",
    "workspace.close",
    "command.invoke",
    "client_shell.surface.set",
    "worktree.list",
    "worktree.create",
    "worktree.open",
    "worktree.remove",
    "product_announcement.dismiss",
    "release_notes.dismiss",
]);
const CLOSING = new Set(["pane.close", "tab.close", "workspace.close", "worktree.remove"]);
const OBSERVATION = new Set([
    "pane.scroll",
    "pane.copy_motion",
    "pane.copy_search",
    "pane.selection.read",
    "pane.link.resolve",
    "worktree.list",
    "product_announcement.dismiss",
    "release_notes.dismiss",
]);
// These change native focus/layout or metadata, but never constitute terminal input.
const CONTROLS = new Set([
    "pane.focus",
    "pane.focus_direction",
    "pane.zoom",
    "pane.resize",
    "layout.set_split_ratio",
    "tab.focus",
    "workspace.focus",
    "tab.rename",
    "workspace.rename",
    "pane.rename",
    "client_shell.surface.set",
]);

type ObjectValue = Record<string, unknown>;
export type TerminalSize = { cols: number; rows: number; cellWidth: number; cellHeight: number };
type Target = { socket: string; pane: string; terminal: string; instanceId: string };
type Ticket = {
    user: string;
    credential: string;
    origin: string;
    expiresAt: number;
    id: string;
    target: Target;
    size: TerminalSize;
};
type Launch = (socket: string, size: TerminalSize) => ChildProcessWithoutNullStreams;

function object(value: unknown): ObjectValue {
    if (value === null || typeof value !== "object" || Array.isArray(value)) {
        throw new HttpError(400, "Expected an object");
    }

    return value as ObjectValue;
}

function size(value: ObjectValue): TerminalSize {
    const integer = (key: string, fallback: number, max: number) => {
        const n = value[key] ?? fallback;

        if (typeof n !== "number" || !Number.isInteger(n) || n < 1 || n > max) {
            throw new HttpError(400, `Invalid terminal ${key}`);
        }

        return n;
    };

    const result = {
        cols: integer("cols", 100, 512),
        rows: integer("rows", 32, 256),
        cellWidth: integer("cellWidth", 8, 64),
        cellHeight: integer("cellHeight", 18, 128),
    };

    if (result.cols * result.rows > MAX_CELLS) {
        throw new HttpError(400, "Terminal geometry is too large");
    }

    return result;
}

function credential(request: IncomingMessage): string {
    return createHash("sha256")
        .update(parseCookies(request.headers.cookie)[COOKIE] || request.headers.authorization || "")
        .digest("hex");
}

function revision(value: unknown): string {
    if (
        (typeof value === "number" && Number.isSafeInteger(value) && value >= 0) ||
        (typeof value === "string" && /^(0|[1-9][0-9]{0,19})$/.test(value))
    ) {
        return String(value);
    }

    throw new Error("Invalid Herdr revision");
}

function ids(value: unknown, key: string): Set<string> {
    if (!Array.isArray(value) || value.length > 5000) {
        throw new Error("Invalid Herdr snapshot collection");
    }

    return new Set(
        value.map((item) => {
            const id = object(item)[key];

            if (typeof id !== "string" || id.length > 256) {
                throw new Error("Invalid Herdr identity");
            }

            return id;
        }),
    );
}

/** Native launch and executable check are the only test seam; tests still exercise the real HTTP/WS lifecycle. */
export class PrivateTerminals {
    readonly #app: PocketApp;
    readonly #tickets = new Map<string, Ticket>();
    readonly #connections = new Set<Connection>();
    readonly #ws = new WebSocketServer({
        noServer: true,
        maxPayload: MAX_COMMAND,
        perMessageDeflate: false,
    });
    #stopped = false;
    #upgrading = 0;
    launch: Launch = (socket, geometry) =>
        spawn(
            HELPER,
            [
                "--socket",
                socket,
                "--cols",
                String(geometry.cols),
                "--rows",
                String(geometry.rows),
                "--cell-width",
                String(geometry.cellWidth),
                "--cell-height",
                String(geometry.cellHeight),
            ],
            { stdio: ["pipe", "pipe", "pipe"], shell: false },
        );
    checkExecutable = () => access(HELPER, constants.X_OK);

    constructor(app: PocketApp) {
        this.#app = app;
    }

    #owner(request: IncomingMessage, expected?: string): User {
        const user = new Auth(this.#app.config).user(request);

        if (!user) {
            throw new HttpError(401, "Sign in first");
        }

        if (user.role !== "owner" || (expected !== undefined && user.id !== expected)) {
            throw new HttpError(403, "Only the owner can control private terminals");
        }

        return user;
    }

    async #endpoint(target: Target): Promise<string> {
        const socket = join(dirname(target.socket), "herdr-client.sock");
        const stat = await lstat(socket).catch(() => undefined);

        if (!stat?.isSocket() || stat.uid !== process.getuid?.()) {
            throw new HttpError(
                409,
                "This Herdr instance has no same-owner structured client endpoint",
            );
        }

        return socket;
    }

    async ticket(request: IncomingMessage, id: string, body: unknown) {
        const user = this.#owner(request);

        if (request.headers["x-pocket"] !== "1") {
            throw new HttpError(403, "Missing X-Pocket header");
        }

        const requestOrigin = origin(request);

        if (request.headers.origin !== undefined && request.headers.origin !== requestOrigin) {
            throw new HttpError(403, "Terminal connections must use the app's origin");
        }

        const input = object(body);

        if (input.acknowledged !== true) {
            throw new HttpError(
                400,
                "Confirm full private terminal control and shared terminal resizing",
            );
        }

        const geometry = size(input);

        for (const [key, value] of this.#tickets) {
            if (value.expiresAt <= Date.now()) {
                this.#tickets.delete(key);
            }
        }

        if (
            this.#stopped ||
            this.#connections.size + this.#upgrading >= MAX_CLIENTS ||
            this.#tickets.size >= 16
        ) {
            throw new HttpError(
                409,
                "Close an existing terminal connection before opening another",
            );
        }

        await this.checkExecutable().catch(() => {
            throw new HttpError(
                503,
                "Build the structured Herdr helper with npm run build:terminal, then connect again",
            );
        });
        this.#owner(request, user.id);
        const target = await this.#app.privateSessions.terminalTarget(user, id);

        await this.#endpoint(target);
        this.#owner(request, user.id);

        // Other ticket requests may have completed while discovery was awaiting I/O.
        if (this.#stopped || this.#tickets.size >= 16) {
            throw new HttpError(
                409,
                "Terminal ticket limit reached; try again after an existing ticket expires",
            );
        }

        const ticket = randomBytes(32).toString("base64url");
        const expiresAt = Date.now() + TICKET_MS;

        this.#tickets.set(ticket, {
            user: user.id,
            credential: credential(request),
            origin: requestOrigin,
            expiresAt,
            id,
            target,
            size: geometry,
        });

        return { ticket, url: `/api/private-terminal?ticket=${ticket}`, expiresAt };
    }

    /** Install on the HTTP server's upgrade event. Authentication and origin checks precede endpoint access. */
    upgrade = (request: IncomingMessage, socket: Duplex, head: Buffer): void => {
        socket.on("error", () => socket.destroy());
        void this.#upgrade(request, socket, head).catch((error) => {
            if (!socket.destroyed) {
                const status = error instanceof HttpError ? error.status : 503;

                // An upgraded socket is no longer covered by HTTP timeouts. Ending only the
                // write side lets a half-open peer retain it indefinitely, even without auth.
                const deadline = setTimeout(() => socket.destroy(), 1000);

                deadline.unref();
                socket.once("close", () => clearTimeout(deadline));
                socket.end(
                    `HTTP/1.1 ${status} Rejected\r\nConnection: close\r\nCache-Control: no-store\r\nContent-Length: 0\r\n\r\n`,
                    () => socket.destroy(),
                );
            }
        });
    };

    async #upgrade(request: IncomingMessage, socket: Duplex, head: Buffer) {
        const user = this.#owner(request);
        const url = new URL(request.url ?? "/", "http://pocket.local");

        if (
            request.method !== "GET" ||
            url.pathname !== "/api/private-terminal" ||
            request.headers.origin !== origin(request)
        ) {
            throw new HttpError(403, "Invalid terminal origin or route");
        }

        const key = url.searchParams.get("ticket") ?? "";
        const ticket = this.#tickets.get(key);

        if (
            !ticket ||
            ticket.expiresAt <= Date.now() ||
            ticket.user !== user.id ||
            ticket.credential !== credential(request) ||
            ticket.origin !== request.headers.origin
        ) {
            throw new HttpError(
                403,
                "Terminal ticket expired or does not belong to this connection",
            );
        }

        this.#tickets.delete(key);

        if (this.#stopped || this.#connections.size + this.#upgrading >= MAX_CLIENTS) {
            throw new HttpError(409, "Terminal connection limit reached");
        }

        this.#upgrading++;
        let upgrading = true;

        try {
            const target = await this.#app.privateSessions.terminalTarget(user, ticket.id);

            if (
                target.socket !== ticket.target.socket ||
                target.pane !== ticket.target.pane ||
                target.terminal !== ticket.target.terminal
            ) {
                throw new HttpError(409, "The selected terminal changed; select it again");
            }

            const endpoint = await this.#endpoint(target);

            this.#owner(request, user.id);

            if (this.#stopped || socket.destroyed) {
                socket.destroy();

                return;
            }

            // Connecting can resize shared panes. Hold through handshake and initial focus enqueue,
            // not the attached lifetime or a PTY-drain acknowledgement. No nested lock ownership is inherited.
            await this.#app.imports.active.local.withTerminalInput(target.socket, undefined, () => {
                let initialization: Promise<void> | undefined;

                this.#ws.handleUpgrade(request, socket, head, (ws) => {
                    let child: ChildProcessWithoutNullStreams;

                    try {
                        child = this.launch(endpoint, ticket.size);
                    } catch {
                        ws.close(1011, "Could not start the structured Herdr helper");

                        return;
                    }

                    const connection = new Connection({
                        ws,
                        child,
                        target,
                        authorize: () => this.#owner(request, user.id),
                        beforeInput: () =>
                            this.#app.privateSessions.markTerminalInput(
                                this.#owner(request, user.id),
                                target.socket,
                            ),
                        withInput: (pane, operation) =>
                            this.#app.imports.active.local.withTerminalInput(
                                target.socket,
                                pane,
                                operation,
                            ),
                        finish: () => {
                            this.#connections.delete(connection);
                        },
                    });

                    this.#connections.add(connection);
                    // A connecting child now counts as a connection, not also as an upgrade.
                    this.#upgrading--;
                    upgrading = false;
                    initialization = connection.start();
                });

                return initialization;
            });
        } finally {
            if (upgrading) {
                this.#upgrading--;
            }
        }
    }

    async close() {
        this.#stopped = true;
        this.#tickets.clear();
        await Promise.all(
            [...this.#connections].map((connection) => connection.close("App shutting down")),
        );
        this.#ws.close();
    }
}

type ConnectionOptions = {
    ws: WebSocket;
    child: ChildProcessWithoutNullStreams;
    target: Target;
    authorize: () => User;
    beforeInput: () => Promise<void>;
    withInput: (pane: string | undefined, operation: () => Promise<void>) => Promise<void>;
    finish: () => void;
};

/** One disposable native client. Full reconstructed frames may be dropped only by closing this connection. */
class Connection {
    readonly #options: ConnectionOptions;
    #boot = "";
    #revision = "";
    #panes = new Set<string>();
    #tabs = new Set<string>();
    #workspaces = new Set<string>();
    #commands = new Set<string>();
    #methods = new Set<string>();
    #popup: string | undefined;
    #chunks: Buffer[] = [];
    #lineBytes = 0;
    #stderr = "";
    #queueBytes = 0;
    #queueCount = 0;
    #chain = Promise.resolve();
    #fence: Promise<void> | undefined;
    #closed = false;
    #initialFocus = false;
    #alive = true;
    #health: ReturnType<typeof setInterval> | undefined;
    #handshake: ReturnType<typeof setTimeout> | undefined;
    #kill: ReturnType<typeof setTimeout> | undefined;
    readonly #requestIds = new Set<string>();
    readonly #done: Promise<void>;
    #resolveDone!: () => void;
    readonly #initialization: Promise<void>;
    #resolveInitialization!: () => void;

    constructor(options: ConnectionOptions) {
        this.#options = options;
        this.#done = new Promise((resolve) => {
            this.#resolveDone = resolve;
        });
        this.#initialization = new Promise((resolve) => {
            this.#resolveInitialization = resolve;
        });
    }

    start(): Promise<void> {
        const { ws, child } = this.#options;

        child.once("error", () => {
            void this.close("Structured Herdr helper could not start");
        });
        child.stdin.on("error", () => {
            void this.close("Herdr input transport closed; input was not retried");
        });
        child.stdout.on("data", (chunk: Buffer) => this.#data(chunk));
        child.stderr.on("data", (chunk: Buffer) => {
            this.#stderr = (this.#stderr + chunk.toString("utf8")).slice(-4096);
        });
        child.once("close", () => {
            void this.close(this.#stderr.trim() || "Herdr disconnected");
            clearTimeout(this.#kill);
            this.#options.finish();
            // Failed initialization retains its reservation until the helper cannot attach later.
            this.#resolveInitialization();
            this.#resolveDone();
        });
        ws.on("message", (data, binary) => {
            const buffer = Buffer.isBuffer(data) ? data : Buffer.from(data as ArrayBuffer);

            this.#queueBytes += buffer.length;
            this.#queueCount++;

            if (
                binary ||
                buffer.length > MAX_COMMAND ||
                this.#queueBytes > MAX_QUEUE ||
                this.#queueCount > 128
            ) {
                void this.close("Terminal input queue exceeded its limit; nothing was retried");

                return;
            }

            this.#chain = this.#chain.then(async () => {
                let command: ObjectValue | undefined;

                try {
                    if (!this.#closed) {
                        command = object(
                            JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(buffer)),
                        );
                        await this.#command(command);
                    }
                } catch (error) {
                    if (error instanceof HttpError && [401, 403].includes(error.status)) {
                        void this.close("Owner access ended");
                    } else {
                        this.#send({
                            type: "rejected",
                            ...(typeof command?.requestId === "string" &&
                            command.requestId.length <= 100
                                ? { requestId: command.requestId }
                                : {}),
                            reason:
                                error instanceof Error ? error.message : "Invalid terminal command",
                        });
                    }
                } finally {
                    this.#queueBytes -= buffer.length;
                    this.#queueCount--;
                }
            });
        });
        ws.on("pong", () => {
            this.#alive = true;
        });
        ws.once("close", () => {
            void this.close("Browser disconnected");
        });
        ws.once("error", () => {
            void this.close("Browser transport failed");
        });
        this.#handshake = setTimeout(() => {
            void this.close("Herdr did not complete the structured handshake");
        }, 15_000).unref();
        let beats = 0;

        this.#health = setInterval(() => {
            try {
                this.#options.authorize();

                if (++beats % 15 === 0) {
                    if (!this.#alive) {
                        void this.close("Browser stopped responding");
                    } else {
                        this.#alive = false;
                        ws.ping();
                    }
                }
            } catch {
                void this.close("Owner access ended");
            }
        }, 1000).unref();

        return this.#initialization;
    }

    #send(value: unknown) {
        const { ws } = this.#options;

        if (this.#closed || ws.readyState !== WebSocket.OPEN) {
            return;
        }

        const text = JSON.stringify(value);

        if (
            Buffer.byteLength(text) > MAX_LINE ||
            ws.bufferedAmount + Buffer.byteLength(text) > MAX_LINE * 2
        ) {
            void this.close(
                "Terminal output exceeded the browser queue limit; reconnect for a fresh frame",
            );

            return;
        }

        ws.send(text);
    }

    #write(value: unknown) {
        if (this.#closed) {
            throw new HttpError(409, "Terminal connection closed; input was not retried");
        }

        const input = this.#options.child.stdin;
        const text = JSON.stringify(value) + "\n";

        if (input.destroyed || input.writableLength + Buffer.byteLength(text) > MAX_QUEUE) {
            throw new HttpError(409, "Terminal input is backpressured; input was not retried");
        }

        input.write(text);
    }

    #data(chunk: Buffer) {
        if (this.#closed) {
            return;
        }

        let offset = 0;

        while (offset < chunk.length) {
            const newline = chunk.indexOf(10, offset);
            const part = chunk.subarray(offset, newline < 0 ? chunk.length : newline);

            this.#lineBytes += part.length;

            if (this.#lineBytes > MAX_LINE) {
                void this.close("Structured Herdr frame exceeded the web limit");

                return;
            }

            this.#chunks.push(part);

            if (newline < 0) {
                return;
            }

            const line =
                this.#chunks.length === 1
                    ? this.#chunks[0]!
                    : Buffer.concat(this.#chunks, this.#lineBytes);

            this.#chunks = [];
            this.#lineBytes = 0;
            offset = newline + 1;

            try {
                const event = object(
                    JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(line)),
                );

                this.#event(event);

                if (this.#closed) {
                    return;
                }
            } catch (error) {
                void this.close(
                    error instanceof Error ? error.message : "Invalid structured Herdr frame",
                );

                return;
            }
        }
    }

    #event(event: ObjectValue) {
        this.#options.authorize();

        if (event.type === "connected") {
            const welcome = object(event.welcome);

            if (welcome.generation !== 1 || !Array.isArray(welcome.methods)) {
                throw new Error("Herdr requires a compatible generation-1 endpoint");
            }

            this.#methods = new Set(
                welcome.methods.filter((item): item is string => typeof item === "string"),
            );
        } else if (event.type === "snapshot") {
            const snapshot = object(event.snapshot);

            if (typeof snapshot.boot_id !== "string" || !snapshot.boot_id) {
                throw new Error("Invalid Herdr snapshot identity");
            }

            if (this.#boot && this.#boot !== snapshot.boot_id) {
                throw new Error("Herdr restarted; reconnect explicitly with a fresh view");
            }

            this.#boot = snapshot.boot_id;
            this.#revision = revision(snapshot.revision);
            this.#panes = ids(snapshot.panes, "pane_id");
            this.#tabs = ids(snapshot.tabs, "tab_id");
            this.#workspaces = ids(snapshot.workspaces, "workspace_id");
            this.#commands = ids(snapshot.commands ?? [], "command_id");

            if (!this.#initialFocus) {
                if (!this.#panes.has(this.#options.target.pane)) {
                    throw new Error("Selected pane no longer exists");
                }

                this.#initialFocus = true;
                this.#write({
                    type: "request",
                    bootId: this.#boot,
                    requestId: "pocket-initial-focus",
                    method: "pane.focus",
                    params: { pane_id: this.#options.target.pane },
                });
                clearTimeout(this.#handshake);
                // Resolve before exposing the snapshot. The reservation's finally runs before
                // any browser command can arrive; subsequent commands acquire their own locks.
                this.#resolveInitialization();
            }
        } else if (event.type === "surface") {
            const surface = object(event.surface);
            const frame = object(surface.frame);

            if (
                surface.boot_id !== this.#boot ||
                revision(surface.projection_revision) !== this.#revision ||
                !Number.isInteger(frame.width) ||
                !Number.isInteger(frame.height) ||
                !Array.isArray(frame.cells)
            ) {
                throw new Error("Herdr frame does not match the current snapshot");
            }

            const count = Number(frame.width) * Number(frame.height);

            if (
                Number(frame.width) < 1 ||
                Number(frame.height) < 1 ||
                count > MAX_CELLS ||
                frame.cells.length !== count
            ) {
                throw new Error("Herdr frame geometry exceeds the web limit");
            }

            this.#popup = surface.popup ? String(object(surface.popup).terminal_id) : undefined;
        } else if (event.type === "closed") {
            void this.close(typeof event.reason === "string" ? event.reason : "Herdr disconnected");

            return;
        } else if (!["images", "message", "response", "rejected"].includes(String(event.type))) {
            throw new Error("Unknown structured Herdr helper event");
        }

        this.#send(event);
    }

    async #command(command: ObjectValue) {
        this.#options.authorize();

        if (command.type === "close") {
            void this.close("Disconnected by owner");

            return;
        }

        if (!this.#boot || command.bootId !== this.#boot) {
            throw new HttpError(409, "Stale Herdr connection; no input sent");
        }

        let mutating = false;
        let terminalInput = false;

        if (command.type === "input" || command.type === "popup-input") {
            const target = command.type === "input" ? command.paneId : command.terminalId;

            if (
                typeof target !== "string" ||
                (command.type === "input" ? !this.#panes.has(target) : target !== this.#popup)
            ) {
                throw new HttpError(409, "Input target is no longer in this Herdr connection");
            }

            if (
                !Array.isArray(command.events) ||
                !command.events.length ||
                command.events.length > 256
            ) {
                throw new HttpError(400, "Invalid terminal event batch");
            }

            mutating = true;
            terminalInput = true;
        } else if (command.type === "clipboard-image") {
            const target = object(command.target);
            const pane = target.Pane;
            const popup = target.Popup;

            if (
                Object.keys(target).length !== 1 ||
                (!(typeof pane === "string" && this.#panes.has(pane)) &&
                    !(typeof popup === "string" && popup === this.#popup))
            ) {
                throw new HttpError(409, "Clipboard target is no longer in this Herdr connection");
            }

            if (
                command.encoding !== "base64" ||
                command.format !== "png" ||
                typeof command.data !== "string" ||
                command.data.length > Math.ceil((8 * 1024 * 1024) / 3) * 4 ||
                command.data.length % 4 !== 0 ||
                !/^[A-Za-z0-9+/]*={0,2}$/.test(command.data)
            ) {
                throw new HttpError(400, "Clipboard images must be PNG and at most 8 MiB");
            }

            const image = Buffer.from(command.data, "base64");

            if (
                image.length < 24 ||
                image.length > 8 * 1024 * 1024 ||
                image.toString("base64") !== command.data ||
                image.subarray(0, 8).toString("hex") !== "89504e470d0a1a0a" ||
                image.subarray(12, 16).toString("ascii") !== "IHDR" ||
                image.readUInt32BE(16) < 1 ||
                image.readUInt32BE(20) < 1 ||
                image.readUInt32BE(16) > 4096 ||
                image.readUInt32BE(20) > 4096
            ) {
                throw new HttpError(400, "Invalid or oversized clipboard PNG");
            }

            mutating = true;
            terminalInput = true;
        } else if (command.type === "resize") {
            Object.assign(command, size(command));
            mutating = true;
        } else if (command.type === "request") {
            if (
                typeof command.requestId !== "string" ||
                !/^[\w-]{1,100}$/.test(command.requestId) ||
                this.#requestIds.has(command.requestId) ||
                this.#requestIds.size >= 4096
            ) {
                throw new HttpError(
                    409,
                    "Use a fresh bounded request ID; commands are never replayed",
                );
            }

            if (
                typeof command.method !== "string" ||
                !METHODS.has(command.method) ||
                !this.#methods.has(command.method)
            ) {
                throw new HttpError(400, "This Herdr operation is not available in the web client");
            }

            const params = object(command.params);

            if (
                command.method === "client_shell.surface.set" &&
                typeof params.active !== "boolean"
            ) {
                throw new HttpError(400, "Surface interest requires active: true or false");
            }

            for (const [key, allowed] of [
                ["pane_id", this.#panes],
                ["target_pane_id", this.#panes],
                ["tab_id", this.#tabs],
                ["workspace_id", this.#workspaces],
            ] as const) {
                if (
                    params[key] !== undefined &&
                    (typeof params[key] !== "string" || !allowed.has(params[key] as string))
                ) {
                    throw new HttpError(
                        409,
                        "Operation target is no longer in this Herdr connection",
                    );
                }
            }

            if (CLOSING.has(command.method) && command.confirmed !== true) {
                throw new HttpError(400, "Confirm closing this Herdr pane, tab or workspace");
            }

            if (
                command.method === "command.invoke" &&
                !this.#commands.has(String(params.command_id))
            ) {
                throw new HttpError(400, "Choose a command advertised by this Herdr instance");
            }

            this.#requestIds.add(command.requestId);
            delete command.confirmed;
            mutating = !OBSERVATION.has(command.method);
            terminalInput = mutating && !CONTROLS.has(command.method);
        } else if (command.type === "focus") {
            if (typeof command.focused !== "boolean") {
                throw new HttpError(400, "Invalid terminal focus state");
            }

            mutating = true;
        } else if (command.type === "theme") {
            object(command.theme);
        } else {
            throw new HttpError(400, "Unsupported structured terminal command");
        }

        if (mutating) {
            await this.#options.withInput(
                command.type === "input" ? String(command.paneId) : undefined,
                async () => {
                    if (terminalInput) {
                        // Persist actual input before enqueue. Geometry/focus need a lock, not a receipt.
                        // A transport close does not cancel Herdr's queued PTY input.
                        this.#fence ??= this.#options.beforeInput();
                        await this.#fence;
                    }

                    this.#options.authorize();
                    this.#write(command);
                },
            );
        } else {
            this.#options.authorize();
            this.#write(command);
        }
    }

    close(reason: string): Promise<void> {
        if (!this.#closed) {
            const { ws, child } = this.#options;

            this.#closed = true;

            if (ws.readyState === WebSocket.OPEN && ws.bufferedAmount < MAX_LINE) {
                ws.send(JSON.stringify({ type: "closed", reason: reason.slice(0, 2048) }));
            }

            clearInterval(this.#health);
            clearTimeout(this.#handshake);

            if (ws.readyState === WebSocket.OPEN) {
                ws.close(1000, "Terminal disconnected");
            }

            setTimeout(() => ws.terminate(), 1000).unref();
            child.stdin.end();
            this.#kill = setTimeout(() => {
                // Only our own bridge child. Never signal Herdr, the pane's shell or its foreground process.
                child.kill("SIGTERM");
                this.#kill = setTimeout(() => child.kill("SIGKILL"), 1000).unref();
            }, 2000).unref();
        }

        return this.#done.then(() => this.#chain);
    }
}
