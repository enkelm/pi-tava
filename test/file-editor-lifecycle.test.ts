// Authoring gate: drive FileEditor's real mount/cleanup and HTTP lifecycle without a DOM/server.
// Only Preact scheduling and EditorView painting are stood in for. CodeMirror state and LSPClient
// are real. Browser tests own completion/formatting UI; this owns hidden traffic, lease races and
// preservation of the same unsaved document/selection across a background longer than lease expiry.
import assert from "node:assert/strict";
import { registerHooks } from "node:module";
import { test } from "node:test";
import { Compartment, EditorState, type TransactionSpec } from "@codemirror/state";
import { EditorView } from "@codemirror/view";
import { diagnosticCount, setDiagnostics } from "@codemirror/lint";

class View {
    state: EditorState;
    destroyed = false;

    constructor({ state }: { state: EditorState }) {
        this.state = state;
        fixture.views.push(this);
    }

    dispatch(spec: TransactionSpec) {
        const transaction = this.state.update(spec);

        this.state = transaction.state;

        for (const listener of this.state.facet(EditorView.updateListener)) {
            listener({ docChanged: transaction.docChanged, state: this.state } as never);
        }
    }

    focus() {}

    destroy() {
        this.destroyed = true;
    }

    static contentAttributes = EditorView.contentAttributes;
    static theme = EditorView.theme;
    static updateListener = EditorView.updateListener;
    static scrollIntoView = EditorView.scrollIntoView;
}

const storeListeners = new Set<() => void>();
const fixture = {
    views: [] as View[],
    effects: [] as (() => (() => void) | undefined)[],
    states: [] as unknown[],
    forceOpen: false,
    store: {
        state: { conversationId: 1, me: { id: "owner", role: "owner" } },
        subscribe(listener: () => void) {
            storeListeners.add(listener);

            return () => storeListeners.delete(listener);
        },
    },
    api: async (
        _path: string,
        _body: Record<string, unknown>,
        _options?: RequestInit,
    ): Promise<unknown> => ({}),
};

Object.assign(globalThis, { editorLifecycleFixture: fixture });
const stubs: Record<string, string> = {
    "preact/hooks": `
        export const useRef = current => ({ current });
        export const useState = initial => [initial === false && globalThis.editorLifecycleFixture.forceOpen ? true : initial,
            value => globalThis.editorLifecycleFixture.states.push(value)];
        export const useEffect = effect => globalThis.editorLifecycleFixture.effects.push(effect);
        export const useId = () => 'editor-status-test';
    `,
    "./store.js": `
        export const store = globalThis.editorLifecycleFixture.store;
        export const api = (...args) => globalThis.editorLifecycleFixture.api(...args);
        export const notify = () => {};
    `,
    "./ui.js": `
        export const html = () => null; export const APPLE = false; export const Loader = () => null;
        export const Icon = () => null; export const anchorStyle = () => ''; export const popAnchor = () => null;
    `,
    "./back.js": `export const useBack = () => {};`,
    "./file-lsp-status.js": `export const FileLspStatus = () => null;`,
    "/vendor/editor.mjs": `
        export { EditorState, Compartment } from ${JSON.stringify(import.meta.resolve("@codemirror/state"))};
        export { keymap } from ${JSON.stringify(import.meta.resolve("@codemirror/view"))};
        export { setDiagnostics } from ${JSON.stringify(import.meta.resolve("@codemirror/lint"))};
        export { LSPClient, serverCompletion, serverDiagnostics, hoverTooltips, signatureHelp } from ${JSON.stringify(import.meta.resolve("@codemirror/lsp-client"))};
        export const EditorView = globalThis.editorLifecycleView;
        export const basicSetup = [], syntaxTheme = [], formatKeymap = [];
        export const languageFor = () => [];
        export const startCompletion = () => {};
        export const formatDocument = () => {};
    `,
};

Object.assign(globalThis, { editorLifecycleView: View });
registerHooks({
    resolve(specifier, context, next) {
        const parent = context.parentURL ?? "";
        const stub = stubs[specifier];
        const target = /\/web\/(file-editor|file-language|file-lsp-status)\.js$/.test(parent);

        return target && stub !== undefined
            ? { url: `data:text/javascript,${encodeURIComponent(stub)}`, shortCircuit: true }
            : next(specifier, context);
    },
});

const { FileEditor } = await import(new URL("../web/file-editor.js", import.meta.url).href);
const { FileLspStatus } = await import(new URL("../web/file-lsp-status.js", import.meta.url).href);

const flush = async () => {
    for (let i = 0; i < 5; i++) {
        await new Promise<void>((resolve) => setImmediate(resolve));
    }
};

function storage() {
    const data = new Map<string, string>();

    return {
        getItem: (key: string) => data.get(key) ?? null,
        setItem: (key: string, value: string) => data.set(key, value),
        removeItem: (key: string) => data.delete(key),
    };
}

test("editor LSP sessions and status polling suspend without replacing the unsaved editor", async (t) => {
    const window = new EventTarget();
    const document = Object.assign(new EventTarget(), { visibilityState: "visible" });
    const navigator = { onLine: true };
    const sessionStorage = storage();
    const globals = {
        window,
        document,
        navigator,
        sessionStorage,
        visualViewport: null,
        ResizeObserver: class {
            observe() {}
            disconnect() {}
        },
    };
    const descriptors = new Map<string, PropertyDescriptor | undefined>();
    const requests: { path: string; body: Record<string, unknown> }[] = [];
    const leases = new Set<string>();
    let sequence = 0;
    let deferOpen = false;
    let delayInitialize = false;
    let deferInitializeResponse = false;
    let failClose = false;
    let deferClose = false;
    let finishOpen: (() => void) | undefined;
    let finishTransport: (() => void) | undefined;
    let transportSignal: AbortSignal | undefined;
    let finishClose: (() => void) | undefined;

    const setUser = (me: { id: string; role: string }) => {
        fixture.store.state.me = me;

        for (const listener of storeListeners) {
            listener();
        }
    };

    const releaseOpen = () => {
        assert.ok(finishOpen);
        finishOpen();
        finishOpen = undefined;
    };

    for (const [name, value] of Object.entries(globals)) {
        descriptors.set(name, Object.getOwnPropertyDescriptor(globalThis, name));
        Object.defineProperty(globalThis, name, { configurable: true, value });
    }

    fixture.api = async (path, body, options) => {
        requests.push({ path, body });

        if (body.action === "open") {
            // The server permits one unsaved-buffer lease per document. Never manufacture a
            // successful replacement while an old open/close is still outstanding.
            assert.equal(leases.size, 0, "close the old lease before opening its replacement");
            const session = `lease-${++sequence}`;

            leases.add(session);

            if (deferOpen) {
                await new Promise<void>((resolve) => {
                    finishOpen = resolve;
                });
            }

            return {
                session,
                uri: "file:///project/file.ts",
                rootUri: "file:///project",
                languageId: "typescript",
            };
        }

        if (body.action === "close") {
            if (failClose) {
                throw new Error("Network unavailable while closing lease");
            }

            if (deferClose) {
                await new Promise<void>((resolve) => {
                    finishClose = resolve;
                });
            }

            leases.delete(String(body.session));

            return {};
        }

        assert.ok(leases.has(String(body.session)), "only live leases can receive messages/polls");
        const message = body.action === "message" ? JSON.parse(String(body.message)) : null;

        if (message?.method === "initialize" && deferInitializeResponse) {
            transportSignal = options?.signal ?? undefined;
            // Model a response already being delivered when abort occurs. Do not manufacture
            // cancellation in the HTTP stub: the production owner must reject stale success.
            await new Promise<void>((resolve) => {
                finishTransport = resolve;
            });
        }

        return {
            messages:
                message?.method === "initialize" && !delayInitialize
                    ? [
                          JSON.stringify({
                              jsonrpc: "2.0",
                              id: message.id,
                              result: {
                                  capabilities: {
                                      textDocumentSync: 1,
                                      documentFormattingProvider: true,
                                  },
                              },
                          }),
                      ]
                    : [],
        };
    };

    const mount = () => {
        fixture.states.length = 0;
        FileEditor({ file: { path: "file.ts", text: "const saved = 1;", revision: "base" } });

        return fixture.effects.splice(0).map((effect) => effect());
    };

    let cleanups: (() => void | undefined)[] = [];

    t.after(async () => {
        cleanups.forEach((cleanup) => cleanup());
        finishOpen?.();
        finishTransport?.();
        finishClose?.();
        await flush();

        for (const [name, descriptor] of descriptors) {
            if (descriptor) {
                Object.defineProperty(globalThis, name, descriptor);
            } else {
                Reflect.deleteProperty(globalThis, name);
            }
        }
    });
    t.mock.timers.enable({ apis: ["setInterval", "setTimeout"] });
    cleanups = mount().filter((cleanup) => cleanup !== undefined);
    await flush();
    assert.ok(fixture.states.includes("connected"), "the real LSP client initialized");
    const view = fixture.views.at(-1)!;

    view.dispatch({
        changes: { from: 0, to: view.state.doc.length, insert: "const unsaved = 2;" },
        selection: { anchor: 8 },
    });
    const draft = sessionStorage.getItem("pocket.file-draft.1.file.ts");

    view.dispatch(
        setDiagnostics(view.state, [
            { from: 0, to: 5, severity: "error", message: "Old server diagnostic" },
        ]),
    );
    assert.equal(diagnosticCount(view.state), 1);
    t.mock.timers.tick(350);
    await flush();
    assert.ok(requests.some(({ body }) => body.action === "poll"));
    document.visibilityState = "hidden";
    document.dispatchEvent(new Event("visibilitychange"));
    await flush();
    const asleep = requests.length;

    t.mock.timers.tick(180_000);
    await flush();
    assert.equal(
        requests.length,
        asleep,
        "hidden editor must not poll or renew a language-server lease",
    );
    assert.equal(leases.size, 0, "backgrounding releases the lease instead of waiting for expiry");
    assert.equal(view.destroyed, false);
    assert.equal(view.state.sliceDoc(), "const unsaved = 2;");
    assert.equal(view.state.selection.main.anchor, 8);
    assert.equal(
        diagnosticCount(view.state),
        0,
        "retired diagnostics must not remain attached to the buffer",
    );
    assert.equal(sessionStorage.getItem("pocket.file-draft.1.file.ts"), draft);
    document.visibilityState = "visible";
    document.dispatchEvent(new Event("visibilitychange"));
    document.dispatchEvent(new Event("visibilitychange"));
    await flush();
    assert.equal(sequence, 2, "one fresh lease after long backgrounding");
    assert.equal(fixture.views.at(-1), view, "reattach language support to the same EditorView");
    assert.equal(view.state.sliceDoc(), "const unsaved = 2;");
    assert.equal(view.state.selection.main.anchor, 8);
    navigator.onLine = false;
    window.dispatchEvent(new Event("offline"));
    await flush();
    const offline = requests.length;

    t.mock.timers.tick(10_000);
    await flush();
    assert.equal(requests.length, offline, "offline has no retry/poll loop");
    assert.equal(leases.size, 0);
    document.visibilityState = "hidden";
    navigator.onLine = true;
    window.dispatchEvent(new Event("online"));
    await flush();
    assert.equal(sequence, 2, "online must not reopen while still hidden");
    cleanups.forEach((cleanup) => cleanup());
    cleanups = [];
    await flush();
    assert.equal(view.destroyed, true);
    assert.ok(
        requests.every(({ path }) => path.endsWith("/lsp")),
        "suspension never writes the file",
    );

    await t.test(
        "store owner-access revocation retires language support, not the draft",
        async () => {
            document.visibilityState = "visible";
            cleanups = mount().filter((cleanup) => cleanup !== undefined);
            await flush();
            assert.ok(fixture.states.includes("connected"));
            const ownedView = fixture.views.at(-1)!;

            ownedView.dispatch({
                changes: {
                    from: 0,
                    to: ownedView.state.doc.length,
                    insert: "private unsaved edit",
                },
                selection: { anchor: 7 },
            });
            ownedView.dispatch(
                setDiagnostics(ownedView.state, [
                    { from: 0, to: 7, severity: "error", message: "Owner-only diagnostic" },
                ]),
            );
            const ownedDraft = sessionStorage.getItem("pocket.file-draft.1.file.ts");
            const beforeRevocation = sequence;

            fixture.states.length = 0;
            setUser({ id: "owner", role: "viewer" });
            await flush();
            assert.equal(leases.size, 0, "revocation closes the owner's language-server lease");
            assert.ok(fixture.states.includes("off"));
            assert.ok(fixture.states.includes("Local editing · language servers are owner-only"));
            assert.equal(diagnosticCount(ownedView.state), 0);
            assert.equal(ownedView.destroyed, false);
            assert.equal(ownedView.state.sliceDoc(), "private unsaved edit");
            assert.equal(ownedView.state.selection.main.anchor, 7);
            assert.equal(sessionStorage.getItem("pocket.file-draft.1.file.ts"), ownedDraft);
            const revokedRequests = requests.length;

            t.mock.timers.tick(10_000);
            await flush();
            assert.equal(requests.length, revokedRequests, "revoked access cannot keep polling");
            setUser({ id: "replacement-owner", role: "owner" });
            await flush();
            assert.equal(
                sequence,
                beforeRevocation,
                "a different owner cannot adopt this editor lease",
            );
            setUser({ id: "owner", role: "owner" });
            await flush();
            assert.equal(
                sequence,
                beforeRevocation + 1,
                "the original owner can regain language support",
            );
            assert.equal(fixture.views.at(-1), ownedView);
            assert.equal(ownedView.state.sliceDoc(), "private unsaved edit");
            assert.ok(fixture.states.includes("connected"));
            cleanups.forEach((cleanup) => cleanup());
            cleanups = [];
            await flush();
            assert.equal(leases.size, 0);
            assert.equal(storeListeners.size, 0, "unmount releases its access subscription");
        },
    );

    await t.test(
        "suspension aborts an in-flight transport and ignores its late success",
        async () => {
            deferInitializeResponse = true;
            cleanups = mount().filter((cleanup) => cleanup !== undefined);
            await flush();
            assert.ok(finishTransport, "initialize is awaiting its HTTP response");
            assert.ok(transportSignal, "editor transport supplies an abort signal");
            assert.equal(transportSignal.aborted, false);
            const abandonedSession = [...leases][0]!;
            const beforeSuspension = sequence;

            document.visibilityState = "hidden";
            document.dispatchEvent(new Event("visibilitychange"));
            assert.equal(transportSignal.aborted, true, "hiding aborts transport immediately");
            fixture.states.length = 0;
            deferInitializeResponse = false;
            finishTransport();
            finishTransport = undefined;
            await flush();
            assert.equal(leases.size, 0, "late HTTP success cannot retain the abandoned lease");
            assert.equal(
                fixture.states.length,
                0,
                "late initialization cannot re-enable language support",
            );
            assert.ok(
                !requests.some(
                    ({ body }) =>
                        body.session === abandonedSession &&
                        body.action === "message" &&
                        JSON.parse(String(body.message)).method === "initialized",
                ),
                "a retired client cannot send a deferred initialized notification",
            );
            document.visibilityState = "visible";
            document.dispatchEvent(new Event("visibilitychange"));
            await flush();
            assert.equal(sequence, beforeSuspension + 1);
            assert.ok(fixture.states.includes("connected"), "only the fresh client can reconnect");
            cleanups.forEach((cleanup) => cleanup());
            cleanups = [];
            await flush();
            assert.equal(leases.size, 0);
        },
    );

    await t.test(
        "a failed background close is retried and awaited before replacement open",
        async () => {
            cleanups = mount().filter((cleanup) => cleanup !== undefined);
            await flush();
            assert.ok(fixture.states.includes("connected"));
            const retainedSession = [...leases][0]!;
            const beforeRecovery = sequence;

            failClose = true;
            document.visibilityState = "hidden";
            document.dispatchEvent(new Event("visibilitychange"));
            await flush();
            assert.ok(
                leases.has(retainedSession),
                "failed cleanup leaves the server lease outstanding",
            );
            const failedCloseRequests = requests.length;

            // Return before the daemon's lease TTL; cleanup, not expiry, must free the document.
            t.mock.timers.tick(10_000);
            await flush();
            assert.equal(
                requests.length,
                failedCloseRequests,
                "failed cleanup has no background retry loop",
            );
            failClose = false;
            deferClose = true;
            document.visibilityState = "visible";
            document.dispatchEvent(new Event("visibilitychange"));
            await flush();
            assert.ok(finishClose, "returning retries the previously failed close");
            assert.equal(requests[failedCloseRequests]!.body.action, "close");
            assert.equal(requests[failedCloseRequests]!.body.session, retainedSession);
            assert.equal(
                sequence,
                beforeRecovery,
                "replacement open waits for cleanup acknowledgement",
            );
            assert.ok(leases.has(retainedSession));
            deferClose = false;
            finishClose();
            finishClose = undefined;
            await flush();
            assert.equal(sequence, beforeRecovery + 1, "replacement opens after cleanup succeeds");
            assert.ok(!leases.has(retainedSession));
            assert.equal(leases.size, 1);
            assert.equal(requests[failedCloseRequests + 1]!.body.action, "open");
            cleanups.forEach((cleanup) => cleanup());
            cleanups = [];
            await flush();
            assert.equal(leases.size, 0);
        },
    );

    // A slow open may finish after hiding. Resume must wait for that abandoned lease to close.
    deferOpen = true;
    document.visibilityState = "visible";
    cleanups = mount().filter((cleanup) => cleanup !== undefined);
    await flush();
    assert.ok(finishOpen);
    document.visibilityState = "hidden";
    document.dispatchEvent(new Event("visibilitychange"));
    document.visibilityState = "visible";
    document.dispatchEvent(new Event("visibilitychange"));
    await flush();
    const openingCount = sequence;

    deferOpen = false;
    releaseOpen();
    await flush();
    assert.equal(sequence, openingCount + 1);
    assert.equal(leases.size, 1);
    cleanups.forEach((cleanup) => cleanup());
    cleanups = [];
    await flush();
    assert.equal(leases.size, 0, "unmount releases the resumed lease");

    // The official client's disconnect does not settle its old initializing promise. A fresh
    // lease must still initialize immediately, rather than waiting for that old 15s timeout.
    delayInitialize = true;
    cleanups = mount().filter((cleanup) => cleanup !== undefined);
    await flush();
    assert.ok(!fixture.states.includes("connected"));
    const initializing = sequence;

    document.visibilityState = "hidden";
    document.dispatchEvent(new Event("visibilitychange"));
    delayInitialize = false;
    document.visibilityState = "visible";
    document.dispatchEvent(new Event("visibilitychange"));
    await flush();
    assert.equal(sequence, initializing + 1, "a retired initialize cannot block its replacement");
    assert.ok(
        fixture.states.includes("connected"),
        "replacement initializes without waiting for the old client",
    );
    const afterResume = fixture.states.length;

    t.mock.timers.tick(16_000);
    await flush();
    assert.equal(
        fixture.states.length,
        afterResume,
        "old initialization timeout cannot disable a new client",
    );
    cleanups.forEach((cleanup) => cleanup());
    cleanups = [];
    await flush();
    assert.equal(leases.size, 0);

    // Advisory saved() must be safe even before initialize resolves. Use the production
    // controller entry point and real client: a deferred didSave on a rejected initialize
    // would create an unhandled rejection inside CodeMirror's notification implementation.
    const lib = await import(
        `data:text/javascript,${encodeURIComponent(stubs["/vendor/editor.mjs"]!)}`
    );
    const { fileLanguage } = await import(new URL("../web/file-language.js", import.meta.url).href);
    const compartment = new Compartment();
    const initializingView = new View({
        state: EditorState.create({
            doc: "user saved during initialize",
            extensions: [compartment.of([])],
        }),
    });

    delayInitialize = true;
    const support = fileLanguage({
        lib,
        view: initializingView,
        compartment,
        conversation: 1,
        path: "file.ts",
        changed: () => {},
    });

    cleanups = [() => support.dispose()];
    await flush();
    support.saved();
    t.mock.timers.tick(15_001);
    await flush();
    support.dispose();
    cleanups = [];
    delayInitialize = false;
    await flush();
    assert.equal(leases.size, 0);

    // An open finishing after unmount must be released without constructing an orphaned client.
    deferOpen = true;
    cleanups = mount().filter((cleanup) => cleanup !== undefined);
    await flush();
    cleanups.forEach((cleanup) => cleanup());
    cleanups = [];
    releaseOpen();
    await flush();
    assert.equal(leases.size, 0);
    document.visibilityState = "hidden";
    const beforeHiddenMount = sequence;

    cleanups = mount().filter((cleanup) => cleanup !== undefined);
    await flush();
    assert.equal(sequence, beforeHiddenMount, "an initially hidden editor never opens a lease");
    cleanups.forEach((cleanup) => cleanup());
    cleanups = [];
    document.visibilityState = "visible";

    // The separately opened status menu must stop its 2-second polling too, including an
    // in-flight response that arrives after the browser has hidden it but before Preact cleanup.
    fixture.forceOpen = true;
    fixture.states.length = 0;
    let statusSignal: AbortSignal | undefined;
    let finishStatus: ((result: unknown) => void) | undefined;
    let reads = 0;

    fixture.api = async (_path, body, options) => {
        assert.equal(body.action, "status");
        reads++;
        statusSignal = options?.signal ?? undefined;

        return new Promise((resolve) => {
            finishStatus = resolve;
        });
    };

    FileLspStatus({
        conversation: 1,
        owner: true,
        state: "connected",
        name: "TS7",
        detail: "Connected",
    });
    cleanups = fixture.effects
        .splice(0)
        .map((effect) => effect())
        .filter((cleanup) => cleanup !== undefined);
    assert.equal(reads, 1);
    document.visibilityState = "hidden";
    document.dispatchEvent(new Event("visibilitychange"));
    assert.ok(statusSignal?.aborted, "backgrounding aborts the pending status read immediately");
    assert.ok(finishStatus);
    finishStatus({ servers: [{ name: "Stale result" }] });
    await flush();
    t.mock.timers.tick(10_000);
    await flush();
    assert.equal(reads, 1, "a retained/closing menu cannot poll in the background");
    assert.ok(!fixture.states.some(Array.isArray), "aborted status results never update the menu");
    assert.ok(fixture.states.includes(false), "backgrounding dismisses the transient status menu");
});
