// One Pi-session picker and confirmation for saved history and live snapshots.
import { useEffect, useRef, useState } from "preact/hooks";
import { api, closeSheet, navigate, notify, openSheet, store } from "../store.js";
import { html, Icon, Loader, Sheet, shortPath, timeAgo } from "../ui.js";

export const piSessionsAvailable = () => {
    const user = store.state.me;

    return (
        user?.role === "owner" ||
        (user?.role === "guest" &&
            user.sessions === undefined &&
            user.projectAccess === undefined &&
            user.continuePiSessions === true)
    );
};

const accountKey = () => JSON.stringify([store.state.me?.id, store.state.me?.role]);

export const canShareImportedChat = (session) =>
    store.state.me?.role === "owner" &&
    session?.imported &&
    session.ownerOnly === true &&
    !session.workItemId &&
    !session.forkedFrom;

/** The menu's selected target and opening survive only while their actual owner and access do. */
export function importSharingAction(id) {
    const account = accountKey();
    const opening = store.state.sheet;

    return () => {
        const target = store.state.sessions.find((session) => session.id === id);

        if (
            accountKey() !== account ||
            store.state.sheet !== opening ||
            !canShareImportedChat(target)
        ) {
            throw new Error("This Chat or account changed. Reopen its options before sharing.");
        }

        openSheet({ type: "share-import", id });
    };
}

export function ImportSheet({ initialPreview = null, fromPrivate = false }) {
    return html`<${Sheet}
        title=${fromPrivate ? "Import & share" : "Import Pi session"}
        onClose=${closeSheet}
    >
        <${ImportPanel} initialPreview=${initialPreview} fromPrivate=${fromPrivate} />
    <//>`;
}

/** Share the existing Chat, not a new snapshot of its original Pi journal. */
export function ShareImportSheet({ id }) {
    const target = store.state.sessions.find((session) => session.id === id);
    const opening = useRef({ account: accountKey(), sheet: store.state.sheet, id });
    const alive = useRef(true);
    const pending = useRef(false);
    const latest = useRef(null);
    const confirmed = useRef(null);
    const [projectId, setProjectId] = useState(target?.projectId ?? "");
    const [consent, setConsent] = useState(null);
    const [busy, setBusy] = useState(false);
    const [error, setError] = useState("");
    const project = (store.state.projects ?? []).find((item) => item.id === projectId);
    const current = () =>
        alive.current &&
        opening.current.account === accountKey() &&
        opening.current.sheet === store.state.sheet &&
        opening.current.id === id &&
        store.state.me?.role === "owner";
    const eligible = current() && canShareImportedChat(target);
    const key = JSON.stringify([
        accountKey(),
        id,
        target?.title,
        target?.projectId,
        projectId,
        project?.name,
    ]);

    latest.current = key;
    const acknowledged = consent === key;

    useEffect(
        () => () => {
            alive.current = false;
        },
        [],
    );

    const submit = async (event) => {
        event.preventDefault();
        const now = store.state.sessions.find((session) => session.id === id);
        const nowProject = (store.state.projects ?? []).find((item) => item.id === projectId);
        const nowKey = JSON.stringify([
            accountKey(),
            id,
            now?.title,
            now?.projectId,
            projectId,
            nowProject?.name,
        ]);

        if (
            !current() ||
            !eligible ||
            !canShareImportedChat(now) ||
            pending.current ||
            !acknowledged ||
            latest.current !== key ||
            confirmed.current !== key ||
            nowKey !== key ||
            (projectId && !project)
        ) {
            return;
        }

        pending.current = true;
        setBusy(true);
        setError("");

        try {
            await api(`pi-sessions/${id}/share`, {
                acknowledged: true,
                projectId: projectId || null,
            });

            if (current()) {
                notify(
                    "info",
                    "Chat shared under project and session-invitation access. The source archive stays owner-only.",
                );
                closeSheet();
            }
        } catch (failure) {
            if (current()) {
                confirmed.current = null;
                setConsent(null);
                setError(failure.message);
            }
        } finally {
            pending.current = false;

            if (alive.current) {
                setBusy(false);
            }
        }
    };

    return html`<${Sheet} title="Share imported Chat" onClose=${closeSheet}>
        ${
            eligible
                ? html`<form class="import-form" onSubmit=${submit}>
            <h3>${target.title ?? "Imported Pi session"}</h3>
            <p class="small">Shares this Chat’s entire current history, including messages added since import, and future messages. It does not re-import the Pi source.</p>
            <${ImportProjectField}
                id="share-import-project"
                value=${projectId}
                busy=${busy}
                onChange=${(event) => {
                    latest.current = null;
                    confirmed.current = null;
                    setConsent(null);
                    setProjectId(event.currentTarget.value);
                }}
            />
            <p class="small muted">Uses normal signed-in access: existing unrestricted access, project grants and session invitations. Never an anonymous link. To invite someone without project access, open this Chat and choose People → Invite → Only this session.</p>
            <label class="check">
                <input
                    id="share-import-consent"
                    type="checkbox"
                    checked=${acknowledged}
                    disabled=${busy}
                    onChange=${(event) => {
                        confirmed.current = event.currentTarget.checked ? key : null;
                        setConsent(confirmed.current);
                    }}
                />
                <span>Share this entire Chat${project ? ` in ${project.name}` : " without a project"}. The original source archive, other Pi branches and existing private forks stay owner-only.</span>
            </label>
            ${error && html`<p class="error-box" role="alert">${error}</p>`}
            <button
                class="button primary wide"
                type="submit"
                disabled=${busy || !acknowledged || (projectId && !project)}
            >
                ${busy ? "Sharing…" : "Share Chat"}
            </button>
        </form>`
                : html`<p class="small muted">This private imported Chat is no longer available to share. Reopen its options to check its current access.</p>`
        }
    <//>`;
}

function ImportProjectField({ id, value, busy, onChange }) {
    return html`<div class="field">
        <label class="label" for=${id}>Project</label>
        <select id=${id} value=${value} disabled=${busy} onChange=${onChange}>
            <option value="">No project</option>
            ${(store.state.projects ?? []).map(
                (project) => html`<option value=${project.id}>${project.name}</option>`,
            )}
        </select>
        <p class="small muted">Project access applies only when Shared. No project uses this Chat’s existing access and session invitations. Its working directory stays unchanged.</p>
    </div>`;
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
    isCurrentOpening,
}) {
    const allowed = piSessionsAvailable();
    const [mode, setMode] = useState("running");
    const [historyVisited, setHistoryVisited] = useState(false);
    const [listing, setListing] = useState(null);
    const [loading, setLoading] = useState(false);
    const [path, setPath] = useState("");
    const [leafId, setLeafId] = useState("");
    const [preview, setPreview] = useState(initialPreview);
    const [model, setModel] = useState("");
    const [thinking, setThinking] = useState("off");
    const [visibility, setVisibility] = useState("owner");
    const [projectId, setProjectId] = useState("");
    const [consent, setConsent] = useState(null);
    const [busy, setBusy] = useState(false);
    const [error, setError] = useState("");
    const alive = useRef(true);
    const pending = useRef(false);
    const generation = useRef(0);
    const scope = useRef({ account: accountKey(), sheet: store.state.sheet });
    const inScope = () =>
        alive.current &&
        scope.current.account === accountKey() &&
        (isCurrentOpening ? isCurrentOpening() : scope.current.sheet === store.state.sheet);
    const selected = preview?.models.find((item) => `${item.provider}/${item.id}` === model);
    const active = Boolean(preview?.activeId);
    const owner = store.state.me?.role === "owner";
    const alreadyShared = preview?.existing !== undefined && preview.visibility === "shared";
    const sharing = fromPrivate || !owner || alreadyShared || visibility === "shared";
    const chosenProject = (store.state.projects ?? []).find((item) => item.id === projectId);
    const intent = useRef(null);
    const confirmed = useRef(null);
    const intentKey = JSON.stringify([
        accountKey(),
        preview?.path,
        preview?.activeId,
        preview?.sha256,
        preview?.leafId,
        preview?.existing,
        preview?.existingTitle,
        model,
        thinking,
        sharing,
        projectId,
        chosenProject?.name,
    ]);

    intent.current = intentKey;
    const acknowledged = consent === intentKey;

    const resetConsent = () => {
        intent.current = null;
        confirmed.current = null;
        setConsent(null);
    };

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
        resetConsent();
        setError("");
    };

    const showPreview = (result) => {
        if (!inScope()) {
            return;
        }

        setPreview(result);
        resetConsent();
        setVisibility(result.visibility === "shared" ? "shared" : "owner");
        setProjectId(result.projectId ?? "");
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
        if (!piSessionsAvailable()) {
            return;
        }

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
        if (allowed && visible && mode === "running" && !preview && !busy) {
            refresh();
        }
    }, [allowed, visible, mode, preview, busy]);

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
        if (!inScope() || !piSessionsAvailable() || pending.current) {
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

        if (
            !inScope() ||
            !piSessionsAvailable() ||
            pending.current ||
            (preview &&
                (!selected ||
                    !acknowledged ||
                    intent.current !== intentKey ||
                    confirmed.current !== intentKey ||
                    (projectId && !chosenProject)))
        ) {
            return;
        }

        const account = accountKey();
        const opening = store.state.sheet;
        const current = () =>
            alive.current &&
            accountKey() === account &&
            store.state.sheet === opening &&
            intent.current === intentKey &&
            piSessionsAvailable();

        pending.current = true;
        setBusy(true);
        setError("");

        try {
            if (!preview) {
                const result = await api("pi-sessions/preview", {
                    path: path.trim(),
                    ...(leafId.trim() ? { leafId: leafId.trim() } : {}),
                });

                if (current()) {
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
                    visibility: sharing ? "shared" : "owner",
                    ...(owner ? { projectId: projectId || null } : {}),
                    ...(preview.existing === undefined ? {} : { existingId: preview.existing }),
                });

                if (!current()) {
                    return;
                }

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
            if (current()) {
                setError(failure.message);

                if (failure.status === 409) {
                    resetConsent();

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

    if (!allowed || !inScope()) {
        return html`<p class="muted small">Local Pi history is unavailable with this access. Reopen Import after changing accounts.</p>`;
    }

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
                        ${
                            preview.existing !== undefined &&
                            html`<p class="small">Opens existing Chat #${preview.existing}: ${preview.existingTitle ?? "Imported Pi session"}. Sharing publishes its entire current history, including messages added since import, and future messages, not just the source excerpts below.</p>`
                        }
                        <div class="field">
                            <label class="label" for="import-model">Destination model</label>
                            <select
                                id="import-model"
                                value=${model}
                                required
                                disabled=${busy}
                                onChange=${(event) => {
                                    resetConsent();
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
                                onChange=${(event) => {
                                    resetConsent();
                                    setThinking(event.currentTarget.value);
                                }}
                            >
                                ${(selected?.levels ?? ["off"]).map((level) => html`<option value=${level}>${level}</option>`)}
                            </select>
                        </div>
                        <div class="field">
                            <label class="label" for="import-visibility">Visibility</label>
                            <select
                                id="import-visibility"
                                value=${sharing ? "shared" : "owner"}
                                disabled=${busy || fromPrivate || !owner || alreadyShared}
                                onChange=${(event) => {
                                    resetConsent();
                                    setVisibility(event.currentTarget.value);
                                }}
                            >
                                <option value="owner">Private — owner only</option>
                                <option value="shared">Shared — project / invitation access</option>
                            </select>
                            <p class="small muted">${alreadyShared ? "This copy is already shared. Reopening it cannot make it private." : "Shared is never anonymous. Choose a project for project-scoped collaborators, or invite people to this Chat."}</p>
                        </div>
                        ${
                            owner &&
                            html`<${ImportProjectField}
                            id="import-project"
                            value=${projectId}
                            busy=${busy || alreadyShared}
                            onChange=${(event) => {
                                resetConsent();
                                setProjectId(event.currentTarget.value);
                            }}
                        />`
                        }
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
                                onChange=${(event) => {
                                    confirmed.current = event.currentTarget.checked
                                        ? intentKey
                                        : null;
                                    setConsent(confirmed.current);
                                }}
                            />
                            <span>${sharing ? `${preview.existing === undefined ? "Copy this saved branch and share the Chat" : `Share existing Chat #${preview.existing}’s entire current history, including messages added since import, and future messages`}${chosenProject ? ` in ${chosenProject.name}` : " under its existing access and session invitations"}. Future messages here are shared too. The source archive and other branches stay owner-only.` : "Copy this saved branch into a private Chat using Coop’s instructions and tools. Only the owner can access it, even in a project."}</span>
                        </label>
                    </section>`
                    }
                    <button
                        class="button primary wide"
                        type="submit"
                        disabled=${busy || (!preview && !path.trim()) || (preview && (!selected || !acknowledged || (projectId && !chosenProject)))}
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
