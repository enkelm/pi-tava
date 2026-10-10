/** Owner-only editor LSP transport. Callers authorize access before opening or using a session. */
import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { randomUUID } from "node:crypto";
import { constants } from "node:fs";
import { access, realpath, stat } from "node:fs/promises";
import { createRequire } from "node:module";
import {
    basename,
    delimiter,
    dirname,
    extname,
    isAbsolute,
    join,
    relative,
    resolve,
} from "node:path";
import { pathToFileURL } from "node:url";
import {
    CancellationTokenSource,
    createMessageConnection,
    ResponseError,
    StreamMessageReader,
    StreamMessageWriter,
    type MessageConnection,
} from "vscode-jsonrpc/node";
import { HttpError } from "./errors.ts";

const SESSION_TTL = 2 * 60_000;
const SERVER_IDLE = 3 * 60_000;
const INITIALIZE_TIMEOUT = 12_000;
const REQUEST_TIMEOUT = 20_000;
const MAX_MESSAGE = 1024 * 1024;
const MAX_OUTPUT = 4 * MAX_MESSAGE;
const MAX_SESSIONS = 32;
const MAX_SERVERS = 8;
const READ_REQUESTS = new Set([
    "textDocument/completion",
    "textDocument/hover",
    "textDocument/signatureHelp",
    "textDocument/formatting",
    "textDocument/rangeFormatting",
    "textDocument/diagnostic",
    "textDocument/documentSymbol",
    "textDocument/documentHighlight",
    "textDocument/foldingRange",
    "textDocument/selectionRange",
    "textDocument/inlayHint",
    "textDocument/semanticTokens/full",
    "textDocument/semanticTokens/full/delta",
    "textDocument/semanticTokens/range",
    "textDocument/definition",
    "textDocument/declaration",
    "textDocument/typeDefinition",
    "textDocument/implementation",
    "textDocument/references",
]);

// Stable daemon capabilities, independent of any browser's initialize parameters.
const CAPABILITIES = {
    general: { positionEncodings: ["utf-16"] },
    workspace: { configuration: true, workspaceFolders: true, applyEdit: false },
    textDocument: {
        synchronization: { dynamicRegistration: false, didSave: true },
        completion: {
            contextSupport: true,
            completionItem: {
                snippetSupport: true,
                documentationFormat: ["markdown", "plaintext"],
                insertReplaceSupport: false,
            },
            completionList: { itemDefaults: ["commitCharacters", "editRange", "insertTextFormat"] },
        },
        hover: { contentFormat: ["markdown", "plaintext"] },
        signatureHelp: {
            contextSupport: true,
            signatureInformation: {
                documentationFormat: ["markdown", "plaintext"],
                parameterInformation: { labelOffsetSupport: true },
                activeParameterSupport: true,
            },
        },
        formatting: {},
        rangeFormatting: {},
        definition: {},
        declaration: {},
        typeDefinition: {},
        implementation: {},
        references: {},
        documentSymbol: {},
        diagnostic: {},
        publishDiagnostics: { versionSupport: true },
    },
};

type ObjectValue = Record<string, unknown>;
type Id = number | string;
type Descriptor = {
    name: string;
    command: string;
    args: string[];
    settings: ObjectValue;
    initializationOptions: ObjectValue;
};
type Pending = { cancellation: CancellationTokenSource; timer: NodeJS.Timeout };
type Server = {
    id: string;
    key: string;
    root: string;
    rootUri: string;
    descriptor: Descriptor;
    child: ChildProcessWithoutNullStreams;
    connection: MessageConnection;
    ready: Promise<ObjectValue>;
    initializeResult?: ObjectValue;
    version: number;
    sessions: Set<Session>;
    pending: Set<Pending>;
    lastUsed: number;
    stopped: boolean;
};
type Session = {
    id: string;
    uri: string;
    server: Server;
    languageId: string;
    version: number;
    browserVersion: number;
    browserOpened: boolean;
    initialized: boolean;
    opened: boolean;
    touched: number;
    pending: Map<Id, Pending>;
    diagnosticTimer?: NodeJS.Timeout;
    diagnosticPending?: Pending;
    output: string[];
    outputBytes: number;
};

export type LspOpenResult = {
    session: string | null;
    status: "ready" | "unavailable" | "busy";
    uri: string;
    rootUri: string;
    languageId: string;
};

export type LspServerStatus = {
    id: string;
    name: string;
    root: string;
    rootUri: string;
    status: "starting" | "running" | "idle";
    documents: number;
};

const SERVER_NAMES: Record<string, string> = {
    tsgo: "TypeScript 7 (tsgo)",
    "pyright-langserver": "Python (pyright-langserver)",
    "rust-analyzer": "Rust (rust-analyzer)",
    gopls: "Go (gopls)",
    clangd: "C/C++ (clangd)",
};

function object(value: unknown): ObjectValue | undefined {
    return value !== null && typeof value === "object" && !Array.isArray(value)
        ? (value as ObjectValue)
        : undefined;
}

function inside(root: string, file: string): boolean {
    const path = relative(root, file);

    return (
        path !== ".." &&
        !path.startsWith(`..${process.platform === "win32" ? "\\" : "/"}`) &&
        !isAbsolute(path)
    );
}

function language(file: string): { id: string; server: string } | undefined {
    const extension = extname(file).toLowerCase();
    const languages: Record<string, string> = {
        ".ts": "typescript",
        ".mts": "typescript",
        ".cts": "typescript",
        ".tsx": "typescriptreact",
        ".js": "javascript",
        ".mjs": "javascript",
        ".cjs": "javascript",
        ".jsx": "javascriptreact",
        ".py": "python",
        ".pyi": "python",
        ".rs": "rust",
        ".go": "go",
        ".c": "c",
        ".h": "c",
        ".cc": "cpp",
        ".cpp": "cpp",
        ".cxx": "cpp",
        ".hh": "cpp",
        ".hpp": "cpp",
        ".hxx": "cpp",
    };
    const id = languages[extension];

    if (!id) {
        return undefined;
    }

    const server =
        id.startsWith("typescript") || id.startsWith("javascript")
            ? "tsgo"
            : id === "python"
              ? "pyright-langserver"
              : id === "rust"
                ? "rust-analyzer"
                : id === "go"
                  ? "gopls"
                  : "clangd";

    return { id, server };
}

async function descriptor(name: string, root: string): Promise<Descriptor | undefined> {
    let command: string | undefined;

    if (name === "tsgo") {
        // This pinned preview exposes no executablePath API. Resolve the bundled platform package
        // from the app, never a project's node_modules or a user-supplied command.
        try {
            const require = createRequire(import.meta.url);
            const pkg = require.resolve(
                `@typescript/native-preview-${process.platform}-${process.arch}/package.json`,
            );

            command = join(dirname(pkg), "lib", process.platform === "win32" ? "tsgo.exe" : "tsgo");
            await access(command, constants.X_OK);
        } catch {
            return undefined;
        }
    } else {
        for (const directory of (process.env.PATH ?? "").split(delimiter)) {
            // No cwd-relative PATH entries, project binaries, or project-local .bin scripts.
            if (!isAbsolute(directory)) {
                continue;
            }

            try {
                const candidate = await realpath(join(directory, name));

                if (inside(root, candidate) || inside(root, await realpath(directory))) {
                    continue;
                }

                await access(candidate, constants.X_OK);
                command = candidate;
                break;
            } catch {
                // Optional servers are not installed everywhere.
            }
        }
    }

    if (!command) {
        return undefined;
    }

    const settings: ObjectValue =
        name === "tsgo"
            ? {
                  "js/ts": { tsserver: { automaticTypeAcquisition: { enabled: false } } },
                  typescript: { disableAutomaticTypeAcquisition: true },
                  javascript: { disableAutomaticTypeAcquisition: true },
              }
            : name === "rust-analyzer"
              ? {
                    "rust-analyzer": {
                        cargo: { buildScripts: { enable: false } },
                        checkOnSave: false,
                        check: { enable: false },
                        procMacro: { enable: false },
                    },
                }
              : name === "gopls"
                ? { gopls: { env: { GOTOOLCHAIN: "local" } } }
                : {};
    const initializationOptions =
        name === "tsgo"
            ? {
                  enableTelemetry: false,
                  userPreferences: {
                      disableAutomaticTypeAcquisition: true,
                      automaticTypeAcquisitionEnabled: false,
                  },
              }
            : name === "rust-analyzer"
              ? (settings["rust-analyzer"] as ObjectValue)
              : {};

    return {
        name,
        command,
        args:
            name === "tsgo"
                ? ["--lsp", "--stdio"]
                : name === "pyright-langserver"
                  ? ["--stdio"]
                  : name === "clangd"
                    ? ["--enable-config=0"]
                    : [],
        settings,
        initializationOptions,
    };
}

function ownedUris(value: unknown, uri: string, depth = 0): boolean {
    if (depth > 32) {
        return false;
    }

    if (Array.isArray(value)) {
        return value.every((item) => ownedUris(item, uri, depth + 1));
    }

    const record = object(value);

    return (
        !record ||
        Object.entries(record).every(([key, item]) =>
            key === "uri" || key.endsWith("Uri") ? item === uri : ownedUris(item, uri, depth + 1),
        )
    );
}

/** Lazy process-local pool. JSON strings are the browser transport; streams use vscode-jsonrpc. */
export class LspPool {
    #servers = new Map<string, Server>();
    #sessions = new Map<string, Session>();
    #leases = new Map<string, Session>();
    #closed = false;
    #sweeper = setInterval(() => this.#sweep(), 10_000).unref();

    async open(root: string, file: string, text: string): Promise<LspOpenResult> {
        if (this.#closed) {
            throw new HttpError(410, "LSP pool is closed");
        }

        if (typeof root !== "string" || typeof file !== "string" || typeof text !== "string") {
            throw new HttpError(400, "LSP root, file and text must be strings");
        }

        if (Buffer.byteLength(text) > MAX_MESSAGE) {
            throw new HttpError(413, "LSP document is too large");
        }

        let canonicalRoot = resolve(root);
        let canonicalFile = resolve(canonicalRoot, file);
        let available = true;

        try {
            canonicalRoot = await realpath(canonicalRoot);
            canonicalFile = await realpath(canonicalFile);
            available =
                (await stat(canonicalRoot)).isDirectory() &&
                (await stat(canonicalFile)).isFile() &&
                inside(canonicalRoot, canonicalFile);
        } catch {
            available = false;
        }

        const selected = language(canonicalFile);
        const result: LspOpenResult = {
            session: null,
            status: "unavailable",
            uri: pathToFileURL(canonicalFile).href,
            rootUri: pathToFileURL(canonicalRoot).href,
            languageId: selected?.id ?? "",
        };

        if (!available || !selected) {
            return result;
        }

        this.#sweep();

        if (this.#leases.has(result.uri) || this.#sessions.size >= MAX_SESSIONS) {
            return { ...result, status: "busy" };
        }

        const executable = await descriptor(selected.server, canonicalRoot);

        if (!executable) {
            return result;
        }

        this.#sweep();

        if (this.#closed) {
            throw new HttpError(410, "LSP pool is closed");
        }

        if (this.#leases.has(result.uri) || this.#sessions.size >= MAX_SESSIONS) {
            return { ...result, status: "busy" };
        }

        const key = `${result.rootUri}\n${executable.name}`;
        let server = this.#servers.get(key);

        if (!server) {
            if (this.#servers.size >= MAX_SERVERS) {
                const idle = [...this.#servers.values()]
                    .filter((item) => !item.sessions.size)
                    .sort((a, b) => a.lastUsed - b.lastUsed)[0];

                if (!idle) {
                    return { ...result, status: "busy" };
                }

                this.#stop(idle);
            }

            try {
                server = this.#launch(key, canonicalRoot, result.rootUri, executable);
            } catch {
                return result;
            }
        }

        const session: Session = {
            id: randomUUID(),
            uri: result.uri,
            server,
            languageId: result.languageId,
            version: ++server.version,
            browserVersion: -1,
            browserOpened: false,
            initialized: false,
            opened: false,
            touched: Date.now(),
            pending: new Map(),
            output: [],
            outputBytes: 0,
        };

        this.#sessions.set(session.id, session);
        this.#leases.set(session.uri, session);
        server.sessions.add(session);

        try {
            await server.ready;

            if (server.stopped || !this.#sessions.has(session.id)) {
                return result;
            }

            session.opened = true;
            this.#notify(server, "textDocument/didOpen", {
                textDocument: {
                    uri: session.uri,
                    languageId: session.languageId,
                    version: session.version,
                    text,
                },
            });

            return { ...result, session: session.id, status: "ready" };
        } catch {
            this.#release(session);

            return result;
        }
    }

    /** Send one browser JSON-RPC message. Async replies are drained by subsequent send/poll calls. */
    send(id: string, message: string): string[] {
        const session = this.#require(id);

        if (typeof message !== "string" || Buffer.byteLength(message) > MAX_MESSAGE) {
            throw new HttpError(413, "LSP message is too large");
        }

        let parsed: unknown;

        try {
            parsed = JSON.parse(message);
        } catch {
            throw new HttpError(400, "Invalid LSP JSON");
        }

        const value = object(parsed);

        if (
            !value ||
            value.jsonrpc !== "2.0" ||
            typeof value.method !== "string" ||
            (value.id !== undefined &&
                typeof value.id !== "string" &&
                !Number.isSafeInteger(value.id))
        ) {
            throw new HttpError(400, "Invalid LSP message");
        }

        const method = value.method;
        const requestId = value.id as Id | undefined;
        const params = object(value.params);

        if (requestId !== undefined) {
            if (session.pending.has(requestId)) {
                throw new HttpError(400, "Duplicate pending LSP request id");
            }

            if (method === "initialize") {
                session.initialized = true;
                this.#queue(session, {
                    jsonrpc: "2.0",
                    id: requestId,
                    result: session.server.initializeResult,
                });
            } else if (method === "shutdown") {
                this.#queue(session, { jsonrpc: "2.0", id: requestId, result: null });
            } else if (!session.initialized) {
                this.#error(session, requestId, -32002, "Client is not initialized");
            } else if (!READ_REQUESTS.has(method)) {
                this.#error(session, requestId, -32601, "LSP method is not allowed");
            } else if (
                !params ||
                object(params.textDocument)?.uri !== session.uri ||
                !ownedUris(params, session.uri)
            ) {
                this.#error(
                    session,
                    requestId,
                    -32602,
                    "LSP request must target the owned document",
                );
            } else if (session.pending.size >= 16 || session.server.pending.size >= 64) {
                this.#error(session, requestId, -32000, "Too many LSP requests");
            } else {
                // Progress tokens are browser-local and must not leak into a shared server.
                const {
                    workDoneToken: _work,
                    partialResultToken: _partial,
                    ...safeParams
                } = params;

                this.#request(session, requestId, method, safeParams);
            }
        } else if (method === "initialized" || method === "shutdown") {
            // The daemon owns the real server's lifecycle.
        } else if (method === "exit") {
            this.#release(session);
        } else if (method === "$/cancelRequest") {
            session.pending.get(params?.id as Id)?.cancellation.cancel();
        } else {
            this.#documentNotification(session, method, params);
        }

        return this.#drain(session);
    }

    /** Polling renews the two-minute lease, but cannot resurrect an already expired session. */
    poll(id: string): string[] {
        return this.#drain(this.#require(id));
    }

    /** Snapshot owned servers without starting processes, renewing leases or triggering recycling. */
    status(): LspServerStatus[] {
        return [...this.#servers.values()].map((server) => ({
            id: server.id,
            name: SERVER_NAMES[server.descriptor.name] ?? server.descriptor.name,
            root: server.root,
            rootUri: server.rootUri,
            status: !server.initializeResult
                ? "starting"
                : server.sessions.size
                  ? "running"
                  : "idle",
            documents: server.sessions.size,
        }));
    }

    /** Close one lease, or close the entire pool on application shutdown. Idempotent. */
    close(id?: string): void {
        if (id !== undefined) {
            const session = this.#sessions.get(id);

            if (session) {
                this.#release(session);
            }

            return;
        }

        this.#closed = true;
        clearInterval(this.#sweeper);

        for (const server of [...this.#servers.values()]) {
            this.#stop(server);
        }
    }

    #launch(key: string, root: string, rootUri: string, executable: Descriptor): Server {
        const child = spawn(executable.command, executable.args, {
            cwd: root,
            stdio: ["pipe", "pipe", "pipe"],
            windowsHide: true,
            env: { ...process.env, GOTOOLCHAIN: "local" },
        });
        const connection = createMessageConnection(
            new StreamMessageReader(child.stdout),
            new StreamMessageWriter(child.stdin),
        );
        const server: Server = {
            id: randomUUID(),
            key,
            root,
            rootUri,
            descriptor: executable,
            child,
            connection,
            ready: Promise.resolve({}),
            version: 0,
            sessions: new Set(),
            pending: new Set(),
            lastUsed: Date.now(),
            stopped: false,
        };

        this.#servers.set(key, server);
        child.stderr.resume();
        child.once("error", () => this.#stop(server));
        child.once("exit", () => this.#stop(server));
        connection.onClose(() => this.#stop(server));
        connection.onError(() => this.#stop(server));
        connection.onRequest((method, params) => {
            if (method === "workspace/applyEdit") {
                return { applied: false, failureReason: "The language server cannot write files" };
            }

            if (method === "workspace/workspaceFolders") {
                return [{ uri: rootUri, name: basename(root) }];
            }

            if (method === "workspace/configuration") {
                const items = object(params)?.items;

                return Array.isArray(items)
                    ? items.slice(0, 64).map((item) => {
                          const section = object(item)?.section;

                          return typeof section === "string"
                              ? Object.hasOwn(executable.settings, section)
                                  ? executable.settings[section]
                                  : null
                              : null;
                      })
                    : [];
            }

            if (method === "window/workDoneProgress/create") {
                return null;
            }

            if (method === "client/registerCapability") {
                const registrations = object(params)?.registrations;

                // TS7 registers a configuration watcher even without dynamicRegistration. Our
                // configuration is immutable, so acknowledge it without installing any watcher.
                if (
                    Array.isArray(registrations) &&
                    registrations.length <= 64 &&
                    registrations.every(
                        (item) => object(item)?.method === "workspace/didChangeConfiguration",
                    )
                ) {
                    return null;
                }
            }

            return new ResponseError(-32601, "Server request is not supported");
        });
        connection.onNotification("textDocument/publishDiagnostics", (params: unknown) => {
            const diagnostics = object(params);
            const session =
                typeof diagnostics?.uri === "string"
                    ? this.#leases.get(diagnostics.uri)
                    : undefined;

            if (
                session?.server === server &&
                session.browserOpened &&
                diagnostics &&
                (diagnostics.version === undefined || diagnostics.version === session.version)
            ) {
                this.#queue(session, {
                    jsonrpc: "2.0",
                    method: "textDocument/publishDiagnostics",
                    params: {
                        ...diagnostics,
                        ...(diagnostics.version === undefined
                            ? {}
                            : { version: session.browserVersion }),
                    },
                });
            }
        });
        connection.listen();
        server.ready = this.#initialize(server, root);

        return server;
    }

    async #initialize(server: Server, root: string): Promise<ObjectValue> {
        const timer = setTimeout(() => this.#stop(server), INITIALIZE_TIMEOUT).unref();

        try {
            const result = object(
                await server.connection.sendRequest("initialize", {
                    processId: process.pid,
                    clientInfo: { name: "pi-coop", version: "1" },
                    rootUri: server.rootUri,
                    rootPath: root,
                    workspaceFolders: [{ uri: server.rootUri, name: basename(root) }],
                    capabilities: CAPABILITIES,
                    initializationOptions: server.descriptor.initializationOptions,
                }),
            );

            if (
                !result ||
                !object(result.capabilities) ||
                Buffer.byteLength(JSON.stringify(result)) > MAX_MESSAGE
            ) {
                throw new Error("Invalid LSP initialize result");
            }

            const encoding = object(result.capabilities)?.positionEncoding;

            if (encoding !== undefined && encoding !== "utf-16") {
                throw new Error("Unsupported LSP position encoding");
            }

            // Do not advertise features the gateway cannot safely serve. In particular, rename,
            // code actions and commands can describe edits to files outside this lease.
            const capabilities = object(result.capabilities)!;
            const sync = capabilities.textDocumentSync;

            // CM sends snapshots when change is 1. LSP allows range-less full replacements even
            // to incremental servers; keep the server's openClose/save flags without hand-applying edits.
            if (typeof sync === "number" && sync !== 0) {
                capabilities.textDocumentSync = 1;
            } else if (object(sync)?.change) {
                capabilities.textDocumentSync = { ...object(sync), change: 1 };
            }

            for (const key of [
                "renameProvider",
                "codeActionProvider",
                "codeLensProvider",
                "executeCommandProvider",
                "workspaceSymbolProvider",
                "documentLinkProvider",
                "documentOnTypeFormattingProvider",
                "callHierarchyProvider",
                "experimental",
            ]) {
                delete capabilities[key];
            }

            const completion = object(capabilities.completionProvider);

            if (completion) {
                completion.resolveProvider = false;
            }

            delete capabilities.workspace;
            server.initializeResult = result;
            await server.connection.sendNotification("initialized", {});

            return result;
        } catch (error) {
            this.#stop(server);

            throw error;
        } finally {
            clearTimeout(timer);
        }
    }

    #documentNotification(session: Session, method: string, params: ObjectValue | undefined): void {
        if (
            !session.initialized ||
            !params ||
            object(params.textDocument)?.uri !== session.uri ||
            !ownedUris(params, session.uri)
        ) {
            throw new HttpError(400, "LSP notification must target the initialized owned document");
        }

        const document = object(params.textDocument)!;
        let text: string;

        if (method === "textDocument/didClose") {
            this.#release(session);

            return;
        }

        if (method === "textDocument/didOpen") {
            if (
                session.browserOpened ||
                typeof document.text !== "string" ||
                !Number.isSafeInteger(document.version) ||
                (document.version as number) < 0
            ) {
                throw new HttpError(400, "Invalid LSP didOpen");
            }

            session.browserOpened = true;
            session.browserVersion = document.version as number;
            text = document.text;
        } else if (method === "textDocument/didChange") {
            if (
                !session.browserOpened ||
                !Number.isSafeInteger(document.version) ||
                (document.version as number) <= session.browserVersion
            ) {
                throw new HttpError(400, "Invalid LSP document version");
            }

            const changes = params.contentChanges;
            const change =
                Array.isArray(changes) && changes.length === 1 ? object(changes[0]) : undefined;

            if (
                !change ||
                typeof change.text !== "string" ||
                "range" in change ||
                "rangeLength" in change
            ) {
                throw new HttpError(400, "LSP accepts only one full-document content change");
            }

            text = change.text;
            session.browserVersion = document.version as number;
        } else if (method === "textDocument/didSave") {
            // Disk writes belong exclusively to the editor's separately guarded save endpoint.
            this.#notify(session.server, method, { textDocument: { uri: session.uri } });

            return;
        } else {
            throw new HttpError(400, "LSP notification is not allowed");
        }

        this.#notify(session.server, "textDocument/didChange", {
            textDocument: {
                uri: session.uri,
                version: (session.version = ++session.server.version),
            },
            contentChanges: [{ text }],
        });
        this.#scheduleDiagnostics(session);
    }

    #call(
        server: Server,
        method: string,
        params: ObjectValue,
    ): { pending: Pending; result: Promise<unknown> } {
        const cancellation = new CancellationTokenSource();
        const pending: Pending = {
            cancellation,
            timer: setTimeout(() => this.#stop(server), REQUEST_TIMEOUT).unref(),
        };

        server.pending.add(pending);
        const result = server.connection
            .sendRequest(method, params, cancellation.token)
            .finally(() => {
                clearTimeout(pending.timer);
                cancellation.dispose();
                server.pending.delete(pending);
            });

        return { pending, result };
    }

    #request(session: Session, id: Id, method: string, params: ObjectValue): void {
        const { pending, result } = this.#call(session.server, method, params);

        session.pending.set(id, pending);
        void result
            .then(
                (value) => this.#queue(session, { jsonrpc: "2.0", id, result: value ?? null }),
                (error: unknown) =>
                    this.#error(
                        session,
                        id,
                        error instanceof ResponseError ? error.code : -32603,
                        error instanceof ResponseError
                            ? error.message
                            : "Language server disconnected",
                    ),
            )
            .finally(() => session.pending.delete(id));
    }

    #scheduleDiagnostics(session: Session): void {
        clearTimeout(session.diagnosticTimer);

        if (
            !this.#sessions.has(session.id) ||
            !session.browserOpened ||
            !object(session.server.initializeResult?.capabilities)?.diagnosticProvider
        ) {
            return;
        }

        // Official CM diagnostics consume push notifications. TS7 exposes file errors by pull,
        // so bridge only this leased document, debounced and with at most one pull per session.
        session.diagnosticTimer = setTimeout(() => {
            session.diagnosticTimer = undefined;

            if (session.diagnosticPending || !this.#sessions.has(session.id)) {
                return;
            }

            if (session.server.pending.size >= 64) {
                this.#scheduleDiagnostics(session);

                return;
            }

            const version = session.version;
            const { pending, result } = this.#call(session.server, "textDocument/diagnostic", {
                textDocument: { uri: session.uri },
            });

            session.diagnosticPending = pending;
            void result
                .then(
                    (value) => {
                        const report = object(value);

                        if (
                            version === session.version &&
                            report?.kind === "full" &&
                            Array.isArray(report.items)
                        ) {
                            this.#queue(session, {
                                jsonrpc: "2.0",
                                method: "textDocument/publishDiagnostics",
                                params: {
                                    uri: session.uri,
                                    version: session.browserVersion,
                                    diagnostics: report.items,
                                },
                            });
                        }
                    },
                    () => {},
                )
                .finally(() => {
                    session.diagnosticPending = undefined;

                    if (version !== session.version) {
                        this.#scheduleDiagnostics(session);
                    }
                });
        }, 200).unref();
    }

    #notify(server: Server, method: string, params: ObjectValue): void {
        if (!server.stopped) {
            void server.connection.sendNotification(method, params).catch(() => this.#stop(server));
        }
    }

    #error(session: Session, id: Id, code: number, message: string): void {
        this.#queue(session, { jsonrpc: "2.0", id, error: { code, message } });
    }

    #queue(session: Session, value: ObjectValue): void {
        if (!this.#sessions.has(session.id)) {
            return;
        }

        let message: string;

        try {
            message = JSON.stringify(value);
        } catch {
            this.#release(session);

            return;
        }

        const bytes = Buffer.byteLength(message);

        if (
            bytes > MAX_MESSAGE ||
            session.output.length >= 256 ||
            session.outputBytes + bytes > MAX_OUTPUT
        ) {
            this.#release(session);

            return;
        }

        session.output.push(message);
        session.outputBytes += bytes;
    }

    #drain(session: Session): string[] {
        const messages = session.output;

        session.output = [];
        session.outputBytes = 0;

        return messages;
    }

    #require(id: string): Session {
        this.#sweep();
        const session = this.#sessions.get(id);

        if (!session) {
            throw new HttpError(410, "LSP session expired or disconnected");
        }

        session.touched = Date.now();

        return session;
    }

    #release(session: Session): void {
        if (!this.#sessions.delete(session.id)) {
            return;
        }

        this.#leases.delete(session.uri);
        session.server.sessions.delete(session);
        session.server.lastUsed = Date.now();
        session.output = [];
        session.outputBytes = 0;
        clearTimeout(session.diagnosticTimer);
        session.diagnosticPending?.cancellation.cancel();

        for (const pending of session.pending.values()) {
            // Keep its timeout until the server acknowledges cancellation, bounding retained RPCs.
            pending.cancellation.cancel();
        }

        if (session.opened) {
            this.#notify(session.server, "textDocument/didClose", {
                textDocument: { uri: session.uri },
            });
        }
    }

    #stop(server: Server): void {
        if (server.stopped) {
            return;
        }

        server.stopped = true;
        this.#servers.delete(server.key);

        for (const session of [...server.sessions]) {
            this.#release(session);
        }

        for (const pending of server.pending) {
            clearTimeout(pending.timer);
        }

        server.connection.dispose();
        server.child.stdin.destroy();
        server.child.stdout.destroy();
        server.child.stderr.destroy();

        if (server.child.exitCode === null && server.child.signalCode === null) {
            server.child.kill("SIGTERM");
            const escalation = setTimeout(() => {
                if (server.child.exitCode === null && server.child.signalCode === null) {
                    server.child.kill("SIGKILL");
                }
            }, 1000).unref();

            server.child.once("exit", () => clearTimeout(escalation));
        }
    }

    #sweep(): void {
        const now = Date.now();

        for (const session of this.#sessions.values()) {
            if (now - session.touched >= SESSION_TTL) {
                this.#release(session);
            }
        }

        for (const server of this.#servers.values()) {
            if (!server.sessions.size && now - server.lastUsed >= SERVER_IDLE) {
                this.#stop(server);
            }
        }
    }
}
