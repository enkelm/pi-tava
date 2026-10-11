// Live Pi moves and saved history share an explicit source picker and import confirmation.
import { useEffect, useRef, useState } from "preact/hooks";
import { api, closeSheet, navigate, notify } from "../store.js";
import { html, Icon, Loader, Sheet, timeAgo } from "../ui.js";

export function ImportSheet({ initialPreview = null, fromPrivate = false }) {
    return html`<${Sheet} title="Import & share" onClose=${closeSheet}>
        <${ImportPanel} initialPreview=${initialPreview} fromPrivate=${fromPrivate} />
    <//>`;
}

/** Saved files are discovered on demand; expanding a row reads only its selected branch. */
function SavedSessions({ visible, busy, onBusyChange, onPreview, onManual }) {
    const [listing, setListing] = useState(null);
    const [loading, setLoading] = useState(false);
    const [query, setQuery] = useState("");
    const [expanded, setExpanded] = useState("");
    const [preview, setPreview] = useState(null);
    const [error, setError] = useState("");
    const [previewError, setPreviewError] = useState("");
    const alive = useRef(true);
    const pending = useRef(false);
    const generation = useRef(0);
    const search = query.trim().toLocaleLowerCase();
    const sessions = listing?.sessions.filter((session) =>
        [session.title, session.cwd, session.path].join(" ").toLocaleLowerCase().includes(search),
    );

    useEffect(
        () => () => {
            alive.current = false;
        },
        [],
    );

    const refresh = async () => {
        const turn = ++generation.current;

        setLoading(true);
        setError("");
        setExpanded("");
        setPreview(null);
        setPreviewError("");

        try {
            const result = await api("imports/history");

            if (alive.current && turn === generation.current) {
                setListing(result);
            }
        } catch (failure) {
            if (alive.current && turn === generation.current) {
                setError(failure.message);
            }
        } finally {
            if (alive.current && turn === generation.current) {
                setLoading(false);
            }
        }
    };

    useEffect(() => {
        if (visible && listing === null && !loading) {
            refresh();
        }
    }, [visible]);

    const expand = async (session, retry = false) => {
        if (pending.current || busy) {
            return;
        }

        if (!retry && expanded === session.path) {
            setExpanded("");

            return;
        }

        setExpanded(session.path);
        setPreview(null);
        setPreviewError("");
        pending.current = true;
        onBusyChange(true);

        try {
            const result = await api("imports/preview", { path: session.path });

            if (alive.current) {
                setPreview(result);
            }
        } catch (failure) {
            if (alive.current) {
                setPreviewError(failure.message);
            }
        } finally {
            pending.current = false;

            if (alive.current) {
                onBusyChange(false);
            }
        }
    };

    return html`<div class="import-history" hidden=${!visible}>
        <p class="small muted">Expand it to review the last saved conversation before importing.</p>
        <div class="field">
            <label class="label" for="import-history-search">Search saved sessions</label>
            <input
                id="import-history-search"
                type="search"
                value=${query}
                placeholder="Title or path"
                autocomplete="off"
                autocapitalize="off"
                spellcheck="false"
                disabled=${busy}
                onInput=${(event) => setQuery(event.currentTarget.value)}
            />
        </div>
        <div class="import-list import-history-list" aria-label="Saved Pi sessions" aria-busy=${loading}>
            ${loading && listing === null && html`<${Loader} label="Finding saved sessions" />`}
            ${listing?.sessions.length === 0 && html`<p>No saved Pi sessions found. Sessions saved by Pi on this server will appear here.</p>`}
            ${listing?.sessions.length > 0 && sessions.length === 0 && html`<p>No matching sessions. Try another title or path.</p>`}
            ${sessions?.map((session, index) => {
                const open = expanded === session.path;
                const id = `import-saved-preview-${index}`;

                return html`<div
                    class="import-session import-history-session"
                    key=${session.path}
                    data-path=${session.path}
                >
                    <button
                        type="button"
                        class="button wide"
                        aria-expanded=${open}
                        aria-controls=${id}
                        disabled=${busy}
                        onClick=${() => expand(session)}
                    >
                        <span class="import-history-heading">
                            <span class="import-history-title">${session.title}</span>
                            <${Icon} name=${open ? "down" : "chevron"} size=${18} />
                        </span>
                        <span class="small import-cwd">${session.cwd}</span>
                        <span class="small muted import-history-path" title=${session.path}>
                            ${session.path}
                        </span>
                        <span class="small muted">${timeAgo(session.modified)} · ${session.messages} messages</span>
                    </button>
                    ${session.reason && html`<p class="small muted">${session.reason}</p>`}
                    ${
                        open &&
                        html`<section
                            id=${id}
                            class="import-history-preview"
                            aria-label="Saved conversation preview"
                            aria-busy=${busy}
                        >
                        ${busy && html`<${Loader} label="Reading saved history" />`}
                        ${
                            previewError &&
                            html`
                            <p class="error-box" role="alert">${previewError}</p>
                            <button
                                class="button small"
                                type="button"
                                disabled=${busy}
                                onClick=${() => expand(session, true)}
                            >
                                Try again
                            </button>
                        `
                        }
                        ${
                            preview &&
                            html`
                            <div class="import-history-messages">
                                ${
                                    preview.history?.length
                                        ? preview.history.slice(-4).map(
                                              (message) => html`<div class="import-history-message">
                                          <span class="small muted">${message.role === "user" ? "User" : "Pi"}</span>
                                          <p>${message.text}</p>
                                      </div>`,
                                          )
                                        : html`<p class="small muted">No text excerpt is available. This branch has ${preview.messages} active messages.</p>`
                                }
                            </div>
                            <details class="import-preview-source">
                                <summary>Source file</summary>
                                <p class="small import-cwd">${preview.path}</p>
                            </details>
                            <p class="small muted">Last saved branch only. The original Pi must have exited before import.</p>
                            <button
                                class="button wide"
                                type="button"
                                disabled=${busy}
                                onClick=${() => onPreview(preview)}
                            >
                                Continue to import
                            </button>
                        `
                        }
                    </section>`
                    }
                </div>`;
            })}
        </div>
        ${listing?.warnings.map((warning) => html`<p class="small muted">${warning}</p>`)}
        ${listing?.directory && html`<p class="small muted import-cwd">Saved sessions in ${listing.directory}</p>`}
        ${error && html`<p class="error-box" role="alert">${error}</p>`}
        <button class="button small" type="button" disabled=${loading || busy} onClick=${refresh}>
            ${loading ? "Refreshing…" : "Refresh"}
        </button>
        <details class="import-manual">
            <summary>Advanced import</summary>
            <p class="small muted">For a session saved outside Pi’s history folder, or a specific branch entry.</p>
            <button
                id="import-file-mode"
                class="button small"
                type="button"
                disabled=${busy}
                onClick=${onManual}
            >
                Import by file path
            </button>
        </details>
    </div>`;
}

/** Import controls hosted by New Session, or the private sharing confirmation. */
export function ImportPanel({
    initialPreview = null,
    fromPrivate = false,
    visible = true,
    onBusyChange,
}) {
    const [mode, setMode] = useState("running");
    const [historyVisited, setHistoryVisited] = useState(false);
    const [listing, setListing] = useState(null);
    const [loading, setLoading] = useState(false);
    const [path, setPath] = useState("");
    const [leafId, setLeafId] = useState("");
    const [preview, setPreview] = useState(initialPreview);
    const previousPreview = useRef(initialPreview);
    const [invalid, setInvalid] = useState(false);
    const [model, setModel] = useState("");
    const [thinking, setThinking] = useState("off");
    const [stopped, setStopped] = useState(false);
    const [acknowledged, setAcknowledged] = useState(false);
    const [abortRunning, setAbortRunning] = useState(false);
    const [busy, setBusy] = useState(false);
    const [error, setError] = useState("");
    const alive = useRef(true);
    const pending = useRef(false);
    const generation = useRef(0);
    const selected = preview?.models.find((item) => `${item.provider}/${item.id}` === model);
    const active = Boolean(preview?.activeId);
    const needsAbort = active && Boolean(preview?.running);
    const sharing = fromPrivate || preview?.visibility === "shared";
    const sourceTab = mode === "running" ? "live" : "history";

    useEffect(
        () => () => {
            alive.current = false;
        },
        [],
    );

    const refresh = async () => {
        const turn = ++generation.current;

        setLoading(true);

        try {
            const result = await api("imports/active");

            if (alive.current && turn === generation.current) {
                setListing(result);
            }
        } catch (failure) {
            if (alive.current && turn === generation.current) {
                setError(failure.message);
            }
        } finally {
            if (alive.current && turn === generation.current) {
                setLoading(false);
            }
        }
    };

    useEffect(() => {
        onBusyChange?.(busy);
    }, [busy, onBusyChange]);

    useEffect(() => {
        if (!visible || mode !== "running" || preview || busy) {
            return;
        }

        refresh();
    }, [visible, mode, preview, busy]);

    const selectSource = (source) => {
        if (busy || pending.current || (source === sourceTab && mode !== "file")) {
            return;
        }

        generation.current++;
        setLoading(false);
        clearPreview();
        setMode(source === "live" ? "running" : "history");

        if (source === "history") {
            setHistoryVisited(true);
        }
    };

    const sourceKeys = (event) => {
        let next;

        if (event.key === "ArrowLeft" || event.key === "ArrowRight") {
            next = mode === "running" ? "history" : "live";
        } else if (event.key === "Home") {
            next = "live";
        } else if (event.key === "End") {
            next = "history";
        } else {
            return;
        }

        event.preventDefault();

        if (!busy) {
            selectSource(next);
            event.currentTarget.querySelector(`#import-tab-${next}`).focus();
        }
    };

    const clearPreview = () => {
        setPreview(null);
        setAcknowledged(false);
        setAbortRunning(false);
        setStopped(false);
        setError("");
    };

    const showPreview = (result) => {
        setPreview(result);
        setAbortRunning(false);
        const preferred = result.sourceModel
            ? `${result.sourceModel.provider}/${result.sourceModel.modelId}`
            : "";
        const available = result.models.find(
            (item) =>
                `${item.provider}/${item.id}` === preferred && (!result.hasImages || item.images),
        );

        setModel(available ? preferred : "");
        setThinking(
            available?.levels.includes(result.sourceThinkingLevel)
                ? result.sourceThinkingLevel
                : "off",
        );
    };

    useEffect(() => {
        if (initialPreview) {
            showPreview(initialPreview);

            if (previousPreview.current !== initialPreview) {
                previousPreview.current = initialPreview;
                setInvalid(false);
                setAcknowledged(false);
            }
        }
    }, [initialPreview]);

    const choose = async (session) => {
        if (pending.current) {
            return;
        }

        pending.current = true;
        setBusy(true);
        setError("");

        try {
            const result = await api("imports/active/preview", { id: session.id });

            if (alive.current) {
                showPreview(result);
            }
        } catch (failure) {
            if (alive.current) {
                setError(failure.message);
            }
        } finally {
            pending.current = false;

            if (alive.current) {
                setBusy(false);
            }
        }
    };

    const submit = async (event) => {
        event.preventDefault();

        if (
            pending.current ||
            invalid ||
            (needsAbort && !abortRunning) ||
            (sharing && (!preview || !acknowledged))
        ) {
            return;
        }

        pending.current = true;
        setBusy(true);
        setError("");

        try {
            if (!preview) {
                const result = await api("imports/preview", {
                    path: path.trim(),
                    ...(leafId.trim() ? { leafId: leafId.trim() } : {}),
                });

                if (alive.current) {
                    showPreview(result);
                }
            } else {
                const result = await api(active ? "imports/active" : "imports", {
                    ...(active ? { id: preview.activeId } : { path: preview.path, stopped }),
                    sha256: preview.sha256,
                    leafId: preview.leafId,
                    model,
                    thinkingLevel: thinking,
                    acknowledged: active || acknowledged,
                    ...(needsAbort ? { abortRunning } : {}),
                    ...(sharing ? { visibility: "shared" } : {}),
                });

                notify(
                    "info",
                    result.existing
                        ? "Opened the existing import."
                        : sharing
                          ? "Imported and shared. The original archive stays owner-only."
                          : "Moved to Durable. Its pane and shell stay open.",
                );

                if (alive.current) {
                    closeSheet();
                    navigate(result.id);
                }
            }
        } catch (failure) {
            if (alive.current) {
                setError(failure.message);

                if (failure.status === 409) {
                    if (fromPrivate) {
                        setInvalid(true);
                        setError(`${failure.message} Close this sheet and preview the pane again.`);
                    } else {
                        setPreview(null);
                    }

                    setAcknowledged(false);
                    setAbortRunning(false);
                    setStopped(false);
                }
            }
        } finally {
            pending.current = false;

            if (alive.current) {
                setBusy(false);
            }
        }
    };

    return html`
        ${
            !fromPrivate &&
            html`<div class="import-source-header">
                ${
                    !preview &&
                    mode !== "file" &&
                    html`<p class="import-source-heading">
                    ${
                        sourceTab === "live"
                            ? "Choose a Pi session to move into Durable."
                            : "Choose a saved session."
                    }
                </p>`
                }
                <div
                    class="import-source-tabs"
                    role="tablist"
                    aria-label="Import source"
                    onKeyDown=${sourceKeys}
                >
                    ${["live", "history"].map((source) => {
                        const current = sourceTab === source;

                        return html`<button
                            key=${source}
                            id=${`import-tab-${source}`}
                            type="button"
                            role="tab"
                            class=${current ? "on" : ""}
                            aria-selected=${current}
                            aria-controls=${`import-panel-${source}`}
                            tabindex=${current ? 0 : -1}
                            disabled=${busy}
                            onClick=${() => selectSource(source)}
                        >
                            ${source === "live" ? "Live" : "History"}
                        </button>`;
                    })}
                </div>
            </div>`
        }
        <section
            id=${fromPrivate ? undefined : `import-panel-${sourceTab}`}
            role=${fromPrivate ? undefined : "tabpanel"}
            aria-labelledby=${fromPrivate ? undefined : `import-tab-${sourceTab}`}
        >
        ${
            mode === "running" &&
            !preview &&
            html`
            ${fromPrivate && html`<p>Choose a Pi session to move into Durable.</p>`}
            <p class="small muted">Idle sessions are ready to import. Running operations need confirmation before they are aborted. Pi stops; its pane and shell stay open.</p>
            <div class="import-list" aria-label="Pi sessions" aria-busy=${loading || busy}>
                ${listing === null && loading && html`<${Loader} label="Finding Pi sessions" />`}
                ${listing?.sessions.length === 0 && html`<p>No Pi sessions found. Check that Herdr is running with its Pi integration enabled.</p>`}
                ${listing?.sessions.map(
                    (session) => html`
                    <div class="import-session" key=${session.id}>
                        <button
                            type="button"
                            class="button wide"
                            disabled=${busy || Boolean(session.reason)}
                            onClick=${() => choose(session)}
                        >
                            <span>${session.title}</span>
                            <span class="small muted">${session.location} · ${session.state}${session.running ? " · confirmation required" : ""}</span>
                            <span class="small import-cwd">${session.cwd}</span>
                            ${session.recovery && html`<span class="small">Review and finish move</span>`}
                        </button>
                        ${session.reason && html`<p class="small muted">${session.reason}</p>`}
                    </div>
                `,
                )}
                ${listing?.warnings.map((warning) => html`<p class="small error-box">${warning}</p>`)}
            </div>
            <button class="button small" type="button" disabled=${loading || busy} onClick=${refresh}>${loading ? "Refreshing…" : "Refresh"}</button>
        `
        }
        ${
            historyVisited &&
            html`<${SavedSessions}
            visible=${visible && mode === "history" && !preview}
            busy=${busy}
            onBusyChange=${setBusy}
            onPreview=${(result) => {
                clearPreview();
                setPath(result.path);
                setLeafId("");
                showPreview(result);
            }}
            onManual=${() => {
                clearPreview();
                setMode("file");
            }}
        />`
        }
        ${
            (mode === "file" || preview) &&
            html`
        ${
            fromPrivate
                ? html`<button class="link small" type="button" onClick=${closeSheet}>Back to private pane</button>`
                : html`<button class="button small" type="button" disabled=${busy} onClick=${() => {
                      clearPreview();
                      setMode(active ? "running" : "history");
                      setHistoryVisited(!active || historyVisited);
                  }}>${active ? "Back to Live" : "Back to History"}</button>`
        }
        <form class="import-form" onSubmit=${submit}>
            ${
                mode === "file" &&
                html`
                <p class="small">Continue one saved branch. Stop the original Pi before importing.</p>
                <div class="field">
                    <label class="label" for="import-path">Session file on this server</label>
                    <input id="import-path" value=${path} placeholder="/absolute/path/to/session.jsonl"
                        autocomplete="off" autocapitalize="off" spellcheck="false" required disabled=${busy}
                        onInput=${(event) => {
                            setPath(event.currentTarget.value);
                            clearPreview();
                        }} />
                </div>
                <div class="field">
                    <label class="label" for="import-leaf">Branch entry ID, optional</label>
                    <input id="import-leaf" value=${leafId} placeholder="Leave empty for the last saved entry"
                        autocomplete="off" autocapitalize="off" spellcheck="false" disabled=${busy}
                        onInput=${(event) => {
                            setLeafId(event.currentTarget.value);
                            clearPreview();
                        }} />
                </div>
            `
            }
            ${
                preview &&
                html`<section aria-label="Import preview">
                <h3>${preview.title}</h3>
                <p class="small import-cwd">${preview.cwd}</p>
                ${active && html`<p>Move stops the original Pi in ${preview.location} and continues its saved branch in Durable. Its terminal stays open.</p>`}
                ${
                    needsAbort &&
                    html`
                    <p class="error-box" role="alert">Running operations will be aborted, like pressing Esc in Pi. Pi then exits and its saved session moves to Durable. Changes already made by tools are not undone.</p>
                    <label class="check">
                        <input
                            id="import-abort-consent"
                            type="checkbox"
                            checked=${abortRunning}
                            disabled=${busy || invalid}
                            onChange=${(event) => setAbortRunning(event.currentTarget.checked)}
                        />
                        <span>Abort running operations and import this session.</span>
                    </label>`
                }
                <p class="small">${sharing ? "The selected conversation becomes available to other signed-in app users. The original archive stays owner-only." : "This conversation stays owner-only."} Extensions and live work do not migrate. New work stays in Durable.</p>
                ${
                    sharing &&
                    html`<label class="check">
                    <input id="import-share-consent" type="checkbox" checked=${acknowledged} disabled=${busy || invalid}
                        onChange=${(event) => setAcknowledged(event.currentTarget.checked)} />
                    <span>I agree to share this conversation with other signed-in app users. Import stops the original Pi but keeps its pane and shell open.</span>
                </label>`
                }
                <div class="field">
                    <label class="label" for="import-model">Destination model</label>
                    <select id="import-model" value=${model} required disabled=${busy}
                        onChange=${(event) => {
                            setModel(event.currentTarget.value);
                            setThinking("off");
                        }}>
                        <option value="">Choose a model</option>
                        ${preview.models.map(
                            (item) => html`
                            <option value=${`${item.provider}/${item.id}`} disabled=${preview.hasImages && !item.images}>
                                ${item.provider}/${item.id}${preview.hasImages && !item.images ? " (text only)" : ""}
                            </option>
                        `,
                        )}
                    </select>
                    ${preview.models.length === 0 && html`<p class="small">No models are available. Sign in under Menu → Providers, then preview again.</p>`}
                </div>
                <div class="field">
                    <label class="label" for="import-thinking">Destination thinking level</label>
                    <select id="import-thinking" value=${thinking} disabled=${busy || !selected} onChange=${(event) => setThinking(event.currentTarget.value)}>
                        ${(selected?.levels ?? ["off"]).map((level) => html`<option value=${level}>${level}</option>`)}
                    </select>
                </div>
                <details>
                    <summary>History and import limits</summary>
                    <p class="small">${preview.entries} records, ${preview.messages} active messages. Selected entry: ${preview.leafId}.</p>
                    <ul class="small">${preview.warnings.map((warning) => html`<li key=${warning}>${warning}</li>`)}</ul>
                </details>
                ${
                    !active &&
                    html`
                    <label class="check">
                        <input type="checkbox" checked=${stopped} disabled=${busy} onChange=${(event) => setStopped(event.currentTarget.checked)} />
                        <span>The original Pi has exited. Its tools and shell work have finished.</span>
                    </label>
                    <label class="check">
                        <input type="checkbox" checked=${acknowledged} disabled=${busy} onChange=${(event) => setAcknowledged(event.currentTarget.checked)} />
                        <span>I accept the limits. Future work stays in Durable, with no write-back to the source.</span>
                    </label>
                `
                }
            </section>`
            }
            <button class="button primary wide" type="submit"
                disabled=${busy || invalid || (needsAbort && !abortRunning) || (sharing && !acknowledged) || (mode === "file" && !path.trim()) || (preview && (!selected || (!active && (!stopped || !acknowledged))))}>
                ${busy ? (active ? "Stopping Pi and importing…" : preview ? "Importing…" : "Reading session…") : needsAbort ? (sharing ? "Abort, import & share" : "Abort and move to Durable") : sharing ? "Import & share" : active ? "Move to Durable" : preview ? "Import and open" : "Preview import"}
            </button>
            ${busy && active && html`<p class="small" role="status">You can close this sheet. The move continues on the server.</p>`}
        </form>`
        }
        ${busy && !preview && mode === "running" && html`<p class="small" role="status">Reading this session…</p>`}
        ${error && html`<p class="error-box" role="alert">${error}</p>`}
        </section>
    `;
}
