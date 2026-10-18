// One Pi-session picker and confirmation for saved history and live snapshots.
import { useEffect, useRef, useState } from "preact/hooks";
import { api, closeSheet, navigate, notify, store } from "../store.js";
import { html, Icon, Loader, Sheet, shortPath, timeAgo } from "../ui.js";

export const piSessionsAvailable = () => {
    const user = store.state.me;

    return (
        user?.role === "owner" ||
        (user?.role === "guest" && user.sessions === undefined && user.continuePiSessions === true)
    );
};

export function ImportSheet({ initialPreview = null, fromPrivate = false }) {
    return html`<${Sheet} title="Import & share" onClose=${closeSheet}>
        <${ImportPanel} initialPreview=${initialPreview} fromPrivate=${fromPrivate} />
    <//>`;
}

/** Preserve newest-first discovery order within each exact working directory and between directories. */
function byFolder(sessions) {
    const folders = new Map();

    for (const session of sessions) {
        if (!folders.has(session.cwd)) {
            folders.set(session.cwd, []);
        }

        folders.get(session.cwd).push(session);
    }

    return [...folders];
}

/** The original picker shows a folder's name first, then its parent, with home shortened to ~. */
function folderParts(cwd, home) {
    const path = shortPath(cwd, home).replace(/\/+$/, "") || "/";
    const cut = path.lastIndexOf("/");

    return cut <= 0
        ? { name: path, parent: "" }
        : { name: path.slice(cut + 1), parent: path.slice(0, cut) };
}

/** Live and History retain the upstream folder layout and use the same copy confirmation. */
function SessionFolders({ sessions, busy, onChoose, saved = false }) {
    const home = store.state.server?.home;

    return html`<div class="pi-results">
        ${byFolder(sessions).map(([cwd, list]) => {
            const { name, parent } = folderParts(cwd, home);

            return html`<section class="pi-folder" key=${cwd} data-cwd=${cwd} aria-label=${cwd}>
                <div class="pi-folder-head" title=${cwd}>
                    <${Icon} name="folder" size=${14} />
                    <span class="pi-folder-name">${name}</span>
                    ${parent && html`<span class="pi-folder-parent">${parent}</span>`}
                </div>
                <div class="pi-folder-list">
                    ${list.map(
                        (session) => html`<button
                        class="pi-session"
                        type="button"
                        key=${session.path ?? session.id}
                        data-path=${saved ? session.path : undefined}
                        title=${session.reason ?? session.path ?? session.cwd}
                        disabled=${busy || Boolean(session.reason)}
                        onClick=${() => onChoose(session)}
                    >
                        <span class="pi-session-text">
                            <span class="pi-session-title">${session.title}</span>
                            <span class="pi-session-meta">
                                ${saved ? `${session.messages} message${session.messages === 1 ? "" : "s"} · ${timeAgo(session.modified)}` : `${session.location} · ${session.state}`}
                            </span>
                            ${session.reason && html`<span class="pi-session-meta">${session.reason}</span>`}
                        </span>
                        ${
                            session.pocket &&
                            html`<span class=${`pi-tag ${session.pocket.behind ? "behind" : ""}`}>
                            ${session.pocket.behind ? "Pi went on" : "in Coop"}
                        </span>`
                        }
                        <${Icon} name="chevron" size=${14} />
                    </button>`,
                    )}
                </div>
            </section>`;
        })}
    </div>`;
}

// The saved catalogue and its bounded previews share the same confirmation as Live.
function SavedSessions({ visible, busy, onBusyChange, onPreview, onManual }) {
    const [listing, setListing] = useState(null);
    const [loading, setLoading] = useState(false);
    const [query, setQuery] = useState("");
    const [error, setError] = useState("");
    const alive = useRef(true);
    const pending = useRef(false);

    useEffect(
        () => () => {
            alive.current = false;
        },
        [],
    );

    const load = async () => {
        setLoading(true);
        setError("");

        try {
            const result = await api("pi-sessions/history");

            if (alive.current) {
                setListing(result);
            }
        } catch (failure) {
            if (alive.current) {
                setError(failure.message);
            }
        } finally {
            if (alive.current) {
                setLoading(false);
            }
        }
    };

    useEffect(() => {
        if (visible && listing === null && !loading && !error) {
            load();
        }
    }, [visible, listing, loading, error]);

    const choose = async (session) => {
        if (pending.current || busy) {
            return;
        }

        pending.current = true;
        onBusyChange?.(true);
        setError("");

        try {
            const result = await api("pi-sessions/preview", { path: session.path });

            if (alive.current) {
                onPreview(result);
            }
        } catch (failure) {
            if (alive.current) {
                setError(failure.message);
            }
        } finally {
            pending.current = false;

            if (alive.current) {
                onBusyChange?.(false);
            }
        }
    };

    const needle = query.trim().toLocaleLowerCase();
    const sessions = (listing?.sessions ?? []).filter(
        (session) =>
            !needle ||
            `${session.title}\n${session.cwd}\n${session.path}`
                .toLocaleLowerCase()
                .includes(needle),
    );

    return html`<div class="import-saved" hidden=${!visible}>
        <div class="import-search-row">
            <input
                id="import-history-search"
                type="search"
                aria-label="Search saved Pi sessions"
                placeholder="Search titles and folders"
                value=${query}
                disabled=${busy}
                onInput=${(event) => setQuery(event.currentTarget.value)}
            />
            <button
                class="button small"
                type="button"
                disabled=${loading || busy}
                onClick=${load}
            >
                ${loading ? "Refreshing…" : "Refresh"}
            </button>
        </div>
        ${loading && listing === null && html`<${Loader} label="Finding saved Pi sessions" />`}
        ${
            listing &&
            html`<div
            class="import-list import-history-list"
            aria-label="Saved Pi sessions"
            aria-busy=${loading || busy}
        >
            ${sessions.length === 0 && html`<p class="small muted">${listing.sessions.length ? "No saved sessions match this search." : "No saved Pi sessions found in this directory. Refresh after Pi saves, or choose another file under Advanced import."}</p>`}
            <${SessionFolders}
                sessions=${sessions}
                busy=${busy || loading}
                onChoose=${choose}
                saved
            />
            <p class="small muted">Copies the last saved branch. The original session is unchanged.</p>
            ${
                listing.warnings.length > 0 &&
                html`<details class="import-history-notes">
                <summary class="small muted">Discovery notes</summary>
                ${listing.warnings.map((warning) => html`<p class="small muted" key=${warning}>${warning}</p>`)}
            </details>`
            }
        </div>`
        }
        ${error && html`<p class="error-box" role="alert">${error}</p>`}
        ${
            store.state.me?.role === "owner" &&
            html`<details class="import-manual">
            <summary>Advanced import</summary>
            <p class="small muted">Choose a session file on this server or a specific branch entry.</p>
            <button class="button small" type="button" disabled=${busy} onClick=${onManual}>
                Choose a file or branch
            </button>
        </details>`
        }
    </div>`;
}

/** One confirmation for both saved files and snapshots of live instances. */
export function ImportPanel({
    initialPreview = null,
    fromPrivate = false,
    visible = true,
    onBusyChange,
    onCreated,
}) {
    const [mode, setMode] = useState("running");
    const [historyVisited, setHistoryVisited] = useState(false);
    const [listing, setListing] = useState(null);
    const [loading, setLoading] = useState(false);
    const [path, setPath] = useState("");
    const [leafId, setLeafId] = useState("");
    const [preview, setPreview] = useState(initialPreview);
    const [model, setModel] = useState("");
    const [thinking, setThinking] = useState("off");
    const [acknowledged, setAcknowledged] = useState(false);
    const [busy, setBusy] = useState(false);
    const [error, setError] = useState("");
    const alive = useRef(true);
    const pending = useRef(false);
    const generation = useRef(0);
    const selected = preview?.models.find((item) => `${item.provider}/${item.id}` === model);
    const active = Boolean(preview?.activeId);
    const sharing = fromPrivate || preview?.visibility === "shared";
    const sourceTab = mode === "running" ? "live" : "history";

    useEffect(
        () => () => {
            alive.current = false;
        },
        [],
    );
    useEffect(() => {
        onBusyChange?.(busy);
    }, [busy, onBusyChange]);

    const clearPreview = () => {
        setPreview(null);
        setAcknowledged(false);
        setError("");
    };

    const showPreview = (result) => {
        setPreview(result);
        setAcknowledged(false);
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
        }
    }, [initialPreview]);

    const refresh = async () => {
        const turn = ++generation.current;

        setLoading(true);
        setError("");

        try {
            const result = await api("pi-sessions/active");

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
        if (visible && mode === "running" && !preview && !busy) {
            refresh();
        }
    }, [visible, mode, preview, busy]);

    const selectSource = (source) => {
        if (busy || pending.current) {
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
        const next =
            event.key === "Home"
                ? "live"
                : event.key === "End"
                  ? "history"
                  : ["ArrowLeft", "ArrowRight"].includes(event.key)
                    ? sourceTab === "live"
                        ? "history"
                        : "live"
                    : null;

        if (next && !busy) {
            event.preventDefault();
            selectSource(next);
            event.currentTarget.querySelector(`#import-tab-${next}`).focus();
        }
    };

    const choose = async (session) => {
        if (pending.current) {
            return;
        }

        pending.current = true;
        setBusy(true);
        setError("");

        try {
            const result = await api("pi-sessions/active/preview", { id: session.id });

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

        if (pending.current || (preview && (!selected || !acknowledged))) {
            return;
        }

        pending.current = true;
        setBusy(true);
        setError("");

        try {
            if (!preview) {
                const result = await api("pi-sessions/preview", {
                    path: path.trim(),
                    ...(leafId.trim() ? { leafId: leafId.trim() } : {}),
                });

                if (alive.current) {
                    showPreview(result);
                }
            } else {
                const result = await api(active ? "pi-sessions/active" : "pi-sessions/continue", {
                    ...(active ? { id: preview.activeId } : { path: preview.path }),
                    sha256: preview.sha256,
                    leafId: preview.leafId,
                    model,
                    thinkingLevel: thinking,
                    acknowledged,
                    ...(sharing ? { visibility: "shared" } : {}),
                });

                notify(
                    "info",
                    result.existing
                        ? "Opened the existing import."
                        : "Saved history copied. The original Pi is unchanged.",
                );

                if (alive.current) {
                    closeSheet();
                    navigate(result.id);
                    onCreated?.(result.id);
                }
            }
        } catch (failure) {
            if (alive.current) {
                setError(failure.message);

                if (failure.status === 409) {
                    setAcknowledged(false);

                    if (!fromPrivate) {
                        setPreview(null);
                    }
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
            <p class="import-source-heading">${preview ? "Review saved history" : sourceTab === "live" ? "Choose a Pi instance" : "Choose a saved session"}</p>
            <div
                class="import-source-tabs"
                role="tablist"
                aria-label="Import source"
                onKeyDown=${sourceKeys}
            >
                ${["live", "history"].map(
                    (source) => html`<button
                    key=${source}
                    id=${`import-tab-${source}`}
                    type="button"
                    role="tab"
                    class=${sourceTab === source ? "on" : ""}
                    aria-selected=${sourceTab === source}
                    aria-controls=${`import-panel-${source}`}
                    tabindex=${sourceTab === source ? 0 : -1}
                    disabled=${busy}
                    onClick=${() => selectSource(source)}
                >
                    ${source === "live" ? "Live" : "History"}
                </button>`,
                )}
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
                <p class="small muted">Copies the last saved branch. Pi keeps running; nothing is stopped or replayed.</p>
                <div class="import-list" aria-label="Pi sessions" aria-busy=${loading || busy}>
                    ${listing === null && loading && html`<${Loader} label="Finding Pi sessions" />`}
                    ${listing?.sessions.length === 0 && html`<p>No live Pi instances found. Try History for saved sessions.</p>`}
                    <${SessionFolders}
                        sessions=${listing?.sessions ?? []}
                        busy=${busy}
                        onChoose=${choose}
                    />
                    ${listing?.warnings.map((warning) => html`<p class="small muted" key=${warning}>${warning}</p>`)}
                </div>
                <button
                    class="button small"
                    type="button"
                    disabled=${loading || busy}
                    onClick=${refresh}
                >
                    ${loading ? "Refreshing…" : "Refresh"}
                </button>
            `
            }
            ${
                historyVisited &&
                html`<${SavedSessions}
                visible=${visible && mode === "history" && !preview}
                busy=${busy}
                onBusyChange=${setBusy}
                onPreview=${showPreview}
                onManual=${() => {
                    clearPreview();
                    setMode("file");
                }}
            />`
            }
            ${
                (mode === "file" || preview) &&
                html`
                <button
                    class="button small"
                    type="button"
                    disabled=${busy}
                    onClick=${
                        fromPrivate
                            ? closeSheet
                            : () => {
                                  clearPreview();
                                  setMode(active ? "running" : "history");
                                  setHistoryVisited(!active || historyVisited);
                              }
                    }
                >
                    ${fromPrivate ? "Back to private pane" : active ? "Back to Live" : "Back to History"}
                </button>
                <form class="import-form" onSubmit=${submit}>
                    ${
                        mode === "file" &&
                        !preview &&
                        html`
                        <div class="field">
                            <label class="label" for="import-path">Session file on this server</label>
                            <input
                                id="import-path"
                                value=${path}
                                placeholder="/absolute/path/to/session.jsonl"
                                autocomplete="off"
                                autocapitalize="off"
                                spellcheck="false"
                                required
                                disabled=${busy}
                                onInput=${(event) => {
                                    setPath(event.currentTarget.value);
                                    clearPreview();
                                }}
                            />
                        </div>
                        <div class="field">
                            <label class="label" for="import-leaf">Branch entry ID, optional</label>
                            <input
                                id="import-leaf"
                                value=${leafId}
                                placeholder="Last saved branch"
                                autocomplete="off"
                                autocapitalize="off"
                                spellcheck="false"
                                disabled=${busy}
                                onInput=${(event) => {
                                    setLeafId(event.currentTarget.value);
                                    clearPreview();
                                }}
                            />
                        </div>
                    `
                    }
                    ${
                        preview &&
                        html`<section id="import-preview" aria-label="Import preview">
                        <h3>${preview.title}</h3>
                        <p class="small import-cwd">${preview.cwd}</p>
                        <p class="small muted">${active ? "Move copies saved history; Pi keeps running." : "Copies saved history without changing the original."} Unfinished work is not resumed here.</p>
                        <div class="field">
                            <label class="label" for="import-model">Destination model</label>
                            <select
                                id="import-model"
                                value=${model}
                                required
                                disabled=${busy}
                                onChange=${(event) => {
                                    setModel(event.currentTarget.value);
                                    setThinking("off");
                                }}
                            >
                                <option value="">Choose a model</option>
                                ${preview.models.map(
                                    (item) => html`<option
                                    value=${`${item.provider}/${item.id}`}
                                    disabled=${preview.hasImages && !item.images}
                                >
                                    ${item.provider}/${item.id}${preview.hasImages && !item.images ? " (text only)" : ""}
                                </option>`,
                                )}
                            </select>
                            ${preview.models.length === 0 && html`<p class="small">No models are available. Ask the owner to configure a provider, then preview again.</p>`}
                        </div>
                        <div class="field">
                            <label class="label" for="import-thinking">Destination thinking level</label>
                            <select
                                id="import-thinking"
                                value=${thinking}
                                disabled=${busy || !selected}
                                onChange=${(event) => setThinking(event.currentTarget.value)}
                            >
                                ${(selected?.levels ?? ["off"]).map((level) => html`<option value=${level}>${level}</option>`)}
                            </select>
                        </div>
                        <details class="import-history-preview">
                            <summary>Saved history and import limits</summary>
                            <div class="import-history-messages">
                                ${preview.history.map(
                                    (
                                        message,
                                        index,
                                    ) => html`<div class="import-history-message" key=${index}>
                                    <span class="label">${message.role === "user" ? "User" : "Pi"}</span>
                                    <p>${message.text}</p>
                                </div>`,
                                )}
                            </div>
                            <p class="small">${preview.entries} records, ${preview.messages} active messages.</p>
                            <ul class="small">
                                ${preview.warnings.map((warning) => html`<li key=${warning}>${warning}</li>`)}
                            </ul>
                        </details>
                        <label class="check">
                            <input
                                id="import-consent"
                                type="checkbox"
                                checked=${acknowledged}
                                disabled=${busy}
                                onChange=${(event) => setAcknowledged(event.currentTarget.checked)}
                            />
                            <span>${sharing ? "Share this copied conversation with app participants. The source archive stays owner-only." : "Continue this saved snapshot with Coop’s instructions and tools. It stays owner-only."}</span>
                        </label>
                    </section>`
                    }
                    <button
                        class="button primary wide"
                        type="submit"
                        disabled=${busy || (!preview && !path.trim()) || (preview && (!selected || !acknowledged))}
                    >
                        ${busy ? (preview ? "Copying history…" : "Reading session…") : !preview ? "Preview import" : "Move"}
                    </button>
                </form>
            `
            }
            ${error && html`<p class="error-box" role="alert">${error}</p>`}
        </section>
    `;
}
