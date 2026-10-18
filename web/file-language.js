// Restartable language support for one mounted editor. The EditorView and its draft outlive leases.
import DOMPurify from "dompurify";
import { api, store } from "./store.js";

/** Ordered, bounded HTTP messages. Retired clients may finish deferred notifications: discard them. */
function transportFor(conversation, session, onFailure) {
    const handlers = new Set();
    let live = true;
    let pending = 0;
    let request = null;
    let chain = Promise.resolve();

    const stop = () => {
        live = false;
        clearInterval(timer);
        request?.abort();
        handlers.clear();

        return chain;
    };

    const enqueue = (body) => {
        if (!live) {
            return;
        }

        if (pending >= 64) {
            onFailure(new Error("Language server queue is full"));

            return;
        }

        pending++;
        chain = chain
            .then(async () => {
                if (!live) {
                    return;
                }

                request = new AbortController();
                const result = await api(
                    `c/${conversation}/lsp`,
                    { ...body, session },
                    { signal: request.signal },
                );

                if (live) {
                    for (const message of result.messages) {
                        for (const handler of handlers) {
                            handler(message);
                        }
                    }
                }
            })
            .catch((error) => {
                if (live) {
                    onFailure(error);
                }
            })
            .finally(() => {
                pending--;
                request = null;
            });
    };

    const timer = setInterval(() => {
        if (live && pending === 0) {
            enqueue({ action: "poll" });
        }
    }, 350);

    return {
        send: (message) => enqueue({ action: "message", message }),
        subscribe: (handler) => handlers.add(handler),
        unsubscribe: (handler) => handlers.delete(handler),
        stop,
    };
}

/** Own fresh clients/leases, never editor contents, history, focus or selection. */
export function fileLanguage({ lib, view, compartment, conversation, path, changed }) {
    const who = store.state.me?.id;
    const leases = new Set();
    let disposed = false;
    let foreground = true;
    let active = false;
    let generation = 0;
    let current = null;
    let queue = Promise.resolve();
    let name = "LSP";
    const authorized = () => store.state.me?.role === "owner" && store.state.me.id === who;
    const awake = () =>
        foreground && document.visibilityState !== "hidden" && navigator.onLine !== false;

    const report = (state, detail, canFormat = false) => {
        if (!disposed) {
            changed({ state, detail, name, canFormat });
        }
    };

    const closeLease = async (session) => {
        if (!leases.has(session)) {
            return;
        }

        try {
            await api(`c/${conversation}/lsp`, { action: "close", session }, { keepalive: true });
            leases.delete(session);
        } catch (error) {
            if (error.status === 404) {
                leases.delete(session);
            }
            // Offline/failed closes are tried again before the next open, never on a background timer.
        }
    };

    const retire = () => {
        const previous = current;

        current = null;

        if (previous) {
            previous.client.disconnect();
            view.dispatch({ effects: compartment.reconfigure([]) });
            view.dispatch(lib.setDiagnostics(view.state, []));
        }

        const drained = previous?.transport.stop();

        // Admission of the previous open/messages and its close must finish before a replacement open.
        // Include leases opened before client construction failed, and late canceled open results.
        queue = Promise.all([queue, drained]).then(async () => {
            for (const session of leases) {
                await closeLease(session);
            }
        });
    };

    const valid = (turn) => !disposed && active && turn === generation && authorized() && awake();

    const fail = (turn, error) => {
        if (valid(turn)) {
            retire();
            report("off", `Local editing · ${error.message}`);
        }
    };

    const update = () => {
        const next = !disposed && authorized() && awake();

        if (next === active) {
            return;
        }

        active = next;
        const turn = ++generation;

        retire();

        if (!next) {
            report(
                "off",
                authorized()
                    ? "Local editing · language support paused while hidden or offline"
                    : "Local editing · language servers are owner-only",
            );

            return;
        }

        report("starting", "Starting language support…");
        queue = queue
            .then(async () => {
                // A close that failed offline may still hold the server's exclusive document lease.
                for (const session of leases) {
                    await closeLease(session);
                }

                if (!valid(turn)) {
                    return;
                }

                const opened = await api(`c/${conversation}/lsp`, { action: "open", path });

                if (opened.session) {
                    leases.add(opened.session);
                }

                if (!valid(turn)) {
                    if (opened.session) {
                        await closeLease(opened.session);
                    }

                    return;
                }

                if (!opened.session) {
                    report(
                        "off",
                        opened.status === "busy"
                            ? "Local editing · language support is in use by another editor"
                            : "Local editing · language support unavailable for this file",
                    );

                    return;
                }

                const client = new lib.LSPClient({
                    rootUri: opened.rootUri,
                    timeout: 15_000,
                    sanitizeHTML: (source) =>
                        DOMPurify.sanitize(source, { USE_PROFILES: { html: true } }),
                    extensions: [
                        lib.serverCompletion(),
                        lib.serverDiagnostics(),
                        lib.hoverTooltips(),
                        lib.signatureHelp(),
                    ],
                });
                const transport = transportFor(conversation, opened.session, (error) =>
                    fail(turn, error),
                );
                const connection = {
                    client,
                    transport,
                    uri: opened.uri,
                    initialized: false,
                    canFormat: false,
                };

                current = connection;
                client.connect(transport);
                // Never serialize recovery behind a retired client's initialization promise. disconnect()
                // does not cancel it, and a slow initialize must not delay lease release/resume.
                client.initializing
                    .then(() => {
                        if (!valid(turn) || current !== connection) {
                            return;
                        }

                        view.dispatch({
                            effects: compartment.reconfigure(
                                client.plugin(opened.uri, opened.languageId),
                            ),
                        });
                        connection.initialized = true;
                        connection.canFormat =
                            !!client.serverCapabilities?.documentFormattingProvider;
                        name = /^(typescript|javascript)/.test(opened.languageId) ? "TS7" : "LSP";
                        report(
                            "connected",
                            /\.[cm]?[jt]sx?$/i.test(path)
                                ? "TypeScript 7 native LSP connected"
                                : "Language server connected",
                            connection.canFormat,
                        );
                    })
                    .catch((error) => fail(turn, error));
            })
            .catch((error) => fail(turn, error));
    };

    const pagehide = () => {
        foreground = false;
        update();

        // Unloading does not run component cleanup or wait for the ordered queue.
        for (const session of leases) {
            closeLease(session);
        }
    };

    const pageshow = () => {
        foreground = true;
        update();
    };

    document.addEventListener("visibilitychange", update);
    window.addEventListener("offline", update);
    window.addEventListener("online", update);
    window.addEventListener("pagehide", pagehide);
    window.addEventListener("pageshow", pageshow);
    const unsubscribe = store.subscribe(update);

    if (!authorized() || !awake()) {
        report(
            "off",
            authorized()
                ? "Local editing · language support paused while hidden or offline"
                : "Local editing · language servers are owner-only",
        );
    }

    update();

    return {
        saved() {
            if (current?.initialized && active) {
                try {
                    current.client.sync();
                    current.client.notification("textDocument/didSave", {
                        textDocument: { uri: current.uri },
                    });
                } catch (error) {
                    fail(generation, error);
                }
            }
        },
        format() {
            if (current?.canFormat && active) {
                lib.formatDocument(view);
            }
        },
        dispose() {
            disposed = true;
            generation++;
            active = false;
            retire();
            document.removeEventListener("visibilitychange", update);
            window.removeEventListener("offline", update);
            window.removeEventListener("online", update);
            window.removeEventListener("pagehide", pagehide);
            window.removeEventListener("pageshow", pageshow);
            unsubscribe();
        },
    };
}
