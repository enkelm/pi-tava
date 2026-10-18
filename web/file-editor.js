// Quick edits use CodeMirror's editor and official LSP client. The daemon owns language-server processes.
import { useEffect, useRef, useState } from "preact/hooks";
import { fileLanguage } from "./file-language.js";
import { FileLspStatus } from "./file-lsp-status.js";
import { api, notify, store } from "./store.js";
import { APPLE, html, Loader } from "./ui.js";

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
    const languageRef = useRef(null);
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
            languageRef.current?.saved();

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
        let language;

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

            language = fileLanguage({
                lib,
                view,
                compartment: lsp,
                conversation,
                path: file.path,
                changed: ({ state, detail, name, canFormat }) => {
                    setLspState(state);
                    setLspStatus(detail);
                    setLspName(name);
                    setCanFormat(canFormat);
                    formatter.current = canFormat ? () => language.format() : null;
                },
            });
            languageRef.current = language;
        })().catch((failure) => {
            if (live) {
                if (!view) {
                    setError(`Could not load the editor: ${failure.message}. Close and try again.`);
                } else {
                    setLspStatus(`Local editing · ${failure.message}`);
                }

                setLspState("off");
                formatter.current = null;
                language?.dispose();
            }
        });

        return () => {
            live = false;
            liveRef.current = false;
            window.removeEventListener("beforeunload", beforeUnload);
            language?.dispose();
            view?.destroy();
            editor.current = null;
            languageRef.current = null;
            formatter.current = null;
            suggestRef.current = null;
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
