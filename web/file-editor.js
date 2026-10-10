// Quick edits use CodeMirror's editor and official LSP client. The daemon owns language-server processes.
import DOMPurify from "dompurify";
import { useEffect, useRef, useState } from "preact/hooks";
import { FileLspStatus } from "./file-lsp-status.js";
import { api, notify, store } from "./store.js";
import { APPLE, html, Loader } from "./ui.js";

/** Ordered, bounded HTTP transport. Polling renews the daemon's document lease, even while idle. */
function transportFor(conversation, session, onFailure) {
    const handlers = new Set();
    let live = true;
    let pending = 0;
    let chain = Promise.resolve();

    const deliver = (messages) => {
        if (live) {
            for (const message of messages) {
                for (const handler of handlers) {
                    handler(message);
                }
            }
        }
    };

    const pagehide = () => {
        // A page reload does not run component cleanup. Keepalive avoids retaining its lease until expiry.
        stop();
        fetch(`/api/c/${conversation}/lsp`, {
            method: "POST",
            headers: { "X-Pocket": "1", "content-type": "application/json" },
            body: JSON.stringify({ action: "close", session }),
            keepalive: true,
        }).catch(() => {});
    };

    const stop = () => {
        if (!live) {
            return;
        }

        live = false;
        clearInterval(timer);
        window.removeEventListener("pagehide", pagehide);
        handlers.clear();
        // Closing after already-admitted messages avoids an in-flight open resurrecting a closed document.
        chain.finally(() =>
            api(`c/${conversation}/lsp`, { action: "close", session }).catch(() => {}),
        );
    };

    const enqueue = (body) => {
        if (!live) {
            throw new Error("Language server disconnected");
        }

        if (pending >= 64) {
            stop();
            onFailure(new Error("Language server queue is full"));

            return;
        }

        pending++;
        chain = chain
            .then(() => live && api(`c/${conversation}/lsp`, { ...body, session }))
            .then((result) => result && deliver(result.messages))
            .catch((error) => {
                stop();
                onFailure(error);
            })
            .finally(() => pending--);
    };

    const timer = setInterval(() => {
        if (live && pending === 0) {
            enqueue({ action: "poll" });
        }
    }, 350);

    window.addEventListener("pagehide", pagehide);

    return {
        send(message) {
            enqueue({ action: "message", message });
        },
        subscribe: (handler) => handlers.add(handler),
        unsubscribe: (handler) => handlers.delete(handler),
        stop,
    };
}

/** Drafts survive Back and live web reloads; explicit Cancel and successful Save remove them. */
export function FileEditor({ file, line, onSaved, onCancel, onReload }) {
    const conversation = store.state.conversationId;
    const draftKey = `pocket.file-draft.${conversation}.${file.path}`;
    const mount = useRef(null);
    const liveRef = useRef(true);
    const editor = useRef(null);
    const saveRef = useRef(null);
    const cancelRef = useRef(null);
    const suggestRef = useRef(null);
    const base = useRef({ text: file.text, revision: file.revision });
    const [ready, setReady] = useState(false);
    const [dirty, setDirty] = useState(false);
    const [saving, setSaving] = useState(false);
    const savingRef = useRef(false);
    const [error, setError] = useState(null);
    const [lspStatus, setLspStatus] = useState("Starting language support…");
    const [lspState, setLspState] = useState("starting");
    const [lspName, setLspName] = useState("LSP");
    const [canFormat, setCanFormat] = useState(false);
    const formatter = useRef(null);
    const clientRef = useRef(null);
    const uriRef = useRef(null);
    const [restored, setRestored] = useState(false);
    const [draftWarning, setDraftWarning] = useState(false);

    const remember = (text) => {
        try {
            if (text === base.current.text) {
                sessionStorage.removeItem(draftKey);
            } else {
                sessionStorage.setItem(draftKey, JSON.stringify({ ...base.current, draft: text }));
            }
        } catch {
            setDraftWarning(true);
        }
    };

    const forget = () => {
        try {
            sessionStorage.removeItem(draftKey);
        } catch {
            // Private browsing can disable storage.
        }
    };

    const save = async () => {
        const view = editor.current;

        if (!view || savingRef.current) {
            return;
        }

        const text = view.state.sliceDoc();

        if (text === base.current.text) {
            return;
        }

        savingRef.current = true;
        setSaving(true);
        setError(null);

        try {
            const saved = await api(`c/${conversation}/edit`, {
                path: file.path,
                text,
                revision: base.current.revision,
            });

            base.current = { text, revision: saved.revision };
            const latest = view.state.sliceDoc();

            setDirty(latest !== text);
            forget();
            remember(latest);
            setRestored(false);

            // Language support is advisory: a disconnect must not turn a completed disk save into an error.
            try {
                clientRef.current?.sync();
                clientRef.current?.notification("textDocument/didSave", {
                    textDocument: { uri: uriRef.current },
                });
            } catch {
                setLspStatus("Local editing · language server disconnected");
                setLspState("off");
                formatter.current = null;
                setCanFormat(false);
            }

            if (liveRef.current) {
                onSaved({ ...file, ...saved, text, size: new TextEncoder().encode(text).length });
            }

            notify("info", "File saved.");
        } catch (failure) {
            setError(failure.message);
        } finally {
            savingRef.current = false;
            setSaving(false);
        }
    };

    saveRef.current = save;
    useEffect(() => {
        liveRef.current = true;
        let live = true;
        let view;
        let client;
        let transport;
        let session;

        const beforeUnload = (event) => {
            if (view && view.state.sliceDoc() !== base.current.text) {
                event.preventDefault();
                event.returnValue = "";
            }
        };

        window.addEventListener("beforeunload", beforeUnload);
        (async () => {
            const lib = await import("/vendor/editor.mjs");

            if (!live) {
                return;
            }

            let text = file.text;

            try {
                const draft = JSON.parse(sessionStorage.getItem(draftKey) || "null");

                if (typeof draft?.draft === "string" && typeof draft.revision === "string") {
                    text = draft.draft;
                    base.current = { text: draft.text, revision: draft.revision };
                    setRestored(true);
                }
            } catch {
                // A damaged draft must not prevent opening the editor.
            }

            const lsp = new lib.Compartment();
            const separator = /\r\n/.test(text) && !/(?<!\r)\n/.test(text) ? "\r\n" : "\n";

            view = new lib.EditorView({
                parent: mount.current,
                state: lib.EditorState.create({
                    doc: text,
                    extensions: [
                        lib.basicSetup,
                        lib.languageFor(file.path),
                        lib.syntaxTheme,
                        lib.EditorState.lineSeparator.of(separator),
                        lib.EditorView.contentAttributes.of({
                            "aria-label": "File editor",
                            spellcheck: "false",
                        }),
                        lib.EditorView.theme({
                            "&": {
                                color: "var(--text)",
                                backgroundColor: "var(--bg)",
                                fontSize: "14px",
                            },
                            ".cm-scroller": { fontFamily: "var(--mono)", overflow: "auto" },
                            ".cm-gutters": {
                                backgroundColor: "var(--card)",
                                color: "var(--muted)",
                                border: "none",
                            },
                            ".cm-activeLine, .cm-activeLineGutter": {
                                backgroundColor: "var(--card)",
                            },
                            ".cm-cursor": { borderLeftColor: "var(--text)" },
                            "&.cm-focused .cm-selectionBackground, .cm-selectionBackground, ::selection":
                                { backgroundColor: "var(--accent-soft)" },
                            ".cm-tooltip": {
                                backgroundColor: "var(--card)",
                                color: "var(--text)",
                                borderColor: "var(--line)",
                            },
                        }),
                        lib.keymap.of([
                            {
                                key: "Mod-s",
                                run: () => {
                                    saveRef.current();

                                    return true;
                                },
                            },
                            {
                                key: "Escape",
                                run: () => {
                                    if (!savingRef.current) {
                                        cancelRef.current?.();
                                    }

                                    return true;
                                },
                            },
                            ...lib.formatKeymap.map((binding) => ({
                                ...binding,
                                run: (on) => {
                                    if (!savingRef.current && formatter.current) {
                                        binding.run(on);
                                    }

                                    return true;
                                },
                            })),
                        ]),
                        lib.EditorView.updateListener.of((update) => {
                            if (update.docChanged) {
                                const current = update.state.sliceDoc();

                                setDirty(current !== base.current.text);
                                remember(current);
                            }
                        }),
                        lsp.of([]),
                    ],
                }),
            });
            editor.current = view;
            suggestRef.current = () => lib.startCompletion(view);
            setDirty(text !== base.current.text);
            setReady(true);

            if (Number.isInteger(line) && line > 0) {
                const at = view.state.doc.line(Math.min(line, view.state.doc.lines)).from;

                view.dispatch({
                    selection: { anchor: at },
                    effects: lib.EditorView.scrollIntoView(at, { y: "center" }),
                });
            }

            view.focus();

            if (store.state.me?.role !== "owner") {
                setLspStatus("Local editing · language servers are owner-only");
                setLspState("off");

                return;
            }

            const opened = await api(`c/${conversation}/lsp`, { action: "open", path: file.path });

            session = opened.session;

            if (!live) {
                if (session) {
                    await api(`c/${conversation}/lsp`, { action: "close", session }).catch(
                        () => {},
                    );
                }

                return;
            }

            if (!session) {
                setLspState("off");
                setLspStatus(
                    opened.status === "busy"
                        ? "Local editing · language support is in use by another editor"
                        : "Local editing · language support unavailable for this file",
                );

                return;
            }

            client = new lib.LSPClient({
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
            transport = transportFor(conversation, session, (failure) => {
                client.disconnect();
                clientRef.current = null;
                formatter.current = null;
                setCanFormat(false);
                setLspState("off");
                setLspStatus(`Local editing · ${failure.message}`);
            });
            clientRef.current = client;
            uriRef.current = opened.uri;
            client.connect(transport);
            await client.initializing;

            if (!live || !client.connected) {
                return;
            }

            view.dispatch({
                effects: lsp.reconfigure(client.plugin(opened.uri, opened.languageId)),
            });
            const formatting = !!client.serverCapabilities?.documentFormattingProvider;

            formatter.current = formatting ? () => lib.formatDocument(view) : null;
            setCanFormat(formatting);
            setLspState("connected");
            setLspName(
                opened.languageId.startsWith("typescript") ||
                    opened.languageId.startsWith("javascript")
                    ? "TS7"
                    : "LSP",
            );
            setLspStatus(
                /\.[cm]?[jt]sx?$/i.test(file.path)
                    ? "TypeScript 7 native LSP connected"
                    : "Language server connected",
            );
        })().catch((failure) => {
            if (live) {
                if (!view) {
                    setError(`Could not load the editor: ${failure.message}. Close and try again.`);
                } else {
                    setLspStatus(`Local editing · ${failure.message}`);
                }

                setLspState("off");
                formatter.current = null;
                transport?.stop();
                client?.disconnect();
            }
        });

        return () => {
            live = false;
            liveRef.current = false;
            window.removeEventListener("beforeunload", beforeUnload);
            view?.destroy();
            editor.current = null;
            clientRef.current = null;
            formatter.current = null;
            suggestRef.current = null;
            transport?.stop();
            client?.disconnect();
        };
    }, [conversation, file.path]);

    const cancel = () => {
        if (dirty && !window.confirm("Discard this unsaved edit?")) {
            return;
        }

        forget();
        onCancel();
    };

    cancelRef.current = cancel;

    const format = () => {
        if (!savingRef.current && formatter.current) {
            formatter.current();
            editor.current?.focus();
        }
    };

    const suggest = () => {
        editor.current?.focus();
        suggestRef.current?.();
    };

    const onKey = (event) => {
        if (event.defaultPrevented || event.isComposing) {
            return;
        }

        const mod = APPLE ? event.metaKey : event.ctrlKey;
        const key = event.key.toLowerCase();

        if (mod && !event.shiftKey && !event.altKey && key === "s") {
            event.preventDefault();
            event.stopPropagation();
            save();
        } else if (event.shiftKey && event.altKey && key === "f") {
            event.preventDefault();
            event.stopPropagation();
            format();
        } else if (event.key === "Escape") {
            event.preventDefault();
            event.stopPropagation();

            if (!savingRef.current) {
                cancel();
            }
        }
    };

    const reload = () => {
        if (dirty && !window.confirm("Discard this edit and reload the file from disk?")) {
            return;
        }

        forget();
        onReload();
    };

    const saveState = saving ? "Saving…" : error ? "Save failed" : dirty ? "Modified" : "Saved";
    const saveDetail = restored
        ? "Recovered unsaved draft. Save checks for changes on disk."
        : dirty
          ? "This file has unsaved changes."
          : "No unsaved changes.";

    return html`<div class="file-edit" onKeyDown=${onKey}>
        ${
            error &&
            html`<div class="file-edit-error" role="alert">
            <span>${error}</span>
            ${
                ready &&
                html`<button class="button small" disabled=${saving} onClick=${reload}>
                Reload from disk
            </button>`
            }
        </div>`
        }
        ${
            draftWarning &&
            html`<p class="file-edit-warning" role="alert">
            Recovery storage is unavailable. Save before leaving.
        </p>`
        }
        ${!ready && !error && html`<${Loader} label="Loading editor" />`}
        <div class="file-edit-surface" ref=${mount}></div>
        <footer class="file-edit-footer">
            <div class="file-edit-statusbar">
                <span
                    class=${`file-edit-save-state ${error ? "failed" : dirty ? "modified" : "saved"}`}
                    role="status"
                    title=${saveDetail}
                >
                    ${saveState}
                </span>
                <${FileLspStatus}
                    conversation=${conversation}
                    owner=${store.state.me?.role === "owner"}
                    state=${lspState}
                    name=${lspName}
                    detail=${lspStatus}
                />
            </div>
            <div class="file-edit-shortcuts" aria-label="Editor shortcuts">
                <button
                    class="file-edit-shortcut"
                    type="button"
                    aria-label="Save"
                    aria-keyshortcuts="Control+S Meta+S"
                    title="Save file"
                    disabled=${!ready || !dirty || saving}
                    onClick=${() => {
                        save();
                        editor.current?.focus();
                    }}
                >
                    Save <kbd aria-hidden="true">${APPLE ? "⌘S" : "Ctrl S"}</kbd>
                </button>
                <button
                    class="file-edit-shortcut"
                    type="button"
                    aria-label="Format"
                    aria-keyshortcuts="Alt+Shift+F"
                    title=${canFormat ? "Format the document without saving" : "Formatting needs a supporting language server"}
                    disabled=${!canFormat || saving}
                    onClick=${format}
                >
                    Format <kbd aria-hidden="true">${APPLE ? "⇧⌥F" : "Shift Alt F"}</kbd>
                </button>
                <button
                    class="file-edit-shortcut"
                    type="button"
                    aria-label="Suggestions"
                    aria-keyshortcuts="Control+Space"
                    title="Show suggestions"
                    disabled=${!ready || saving}
                    onClick=${suggest}
                >
                    Suggest <kbd aria-hidden="true">${APPLE ? "⌃Space" : "Ctrl Space"}</kbd>
                </button>
                <button
                    class="file-edit-shortcut"
                    type="button"
                    aria-label="Cancel"
                    aria-keyshortcuts="Escape"
                    title="Leave editing; discard unsaved changes after confirmation"
                    disabled=${saving}
                    onClick=${cancel}
                >
                    Cancel <kbd aria-hidden="true">Esc</kbd>
                </button>
            </div>
        </footer>
    </div>`;
}
