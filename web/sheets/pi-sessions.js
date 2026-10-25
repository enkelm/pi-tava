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
function SavedSessions({ visible, busy, isActive, onChoose, onManual, fieldId }) {
    const [listing, setListing] = useState(null);
    const [loading, setLoading] = useState(false);
    const [query, setQuery] = useState("");
    const [error, setError] = useState("");
    const alive = useRef(true);
    const generation = useRef(0);
    const latest = useRef(null);

    latest.current = { visible, isActive };
    const current = () => alive.current && latest.current.visible && latest.current.isActive();

    useEffect(
        () => () => {
            alive.current = false;
        },
        [],
    );

    const load = async () => {
        if (!current()) {
            return;
        }

        const turn = ++generation.current;

        setLoading(true);
        setError("");

        try {
            const result = await api("pi-sessions/history");

            if (current() && turn === generation.current) {
                setListing(result);
            }
        } catch (failure) {
            if (current() && turn === generation.current) {
                setError(failure.message);
            }
        } finally {
            if (alive.current && turn === generation.current) {
                setLoading(false);
            }
        }
    };

    useEffect(() => {
        if (visible && listing === null && !loading && !error) {
            load();
        }
    }, [visible, listing, loading, error, busy]);

    const choose = (session) => {
        if (current()) {
            setError("");

            return onChoose(session);
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
                id=${fieldId("import-history-search")}
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

/**
 * One confirmation for saved/live history. isCurrentOpening owns lifetime across retained children;
 * isActive and visible gate current dispatch/results. onComplete replaces default sheet navigation;
 * idPrefix isolates retained inline controls from native import children.
 */
export function ImportPanel({
    initialPreview = null,
    fromPrivate = false,
    visible = true,
    idPrefix = "",
    onBusyChange,
    onCreated,
    isCurrentOpening,
    isActive,
    onComplete,
}) {
    const allowed = piSessionsAvailable();
    const fieldId = (name) => (idPrefix ? `${idPrefix}-${name}` : name);
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
    const accessKey = () =>
        JSON.stringify([
            accountKey(),
            store.state.me?.sessions,
            store.state.me?.projectAccess,
            store.state.me?.continuePiSessions,
        ]);
    const scope = useRef({ account: accessKey(), sheet: store.state.sheet });
    const latest = useRef(null);
    const reportedBusy = useRef(null);
    const inScope = () =>
        alive.current &&
        scope.current.account === accessKey() &&
        (latest.current.isCurrentOpening
            ? latest.current.isCurrentOpening()
            : scope.current.sheet === store.state.sheet);
    const current = () =>
        inScope() &&
        piSessionsAvailable() &&
        latest.current.visible &&
        (!latest.current.isActive || latest.current.isActive());
    const selected = preview?.models.find((item) => `${item.provider}/${item.id}` === model);
    const active = Boolean(preview?.activeId);
    const owner = store.state.me?.role === "owner";
    const alreadyShared = preview?.existing !== undefined && preview.visibility === "shared";
    const sharing = fromPrivate || !owner || alreadyShared || visibility === "shared";
    const chosenProject = (store.state.projects ?? []).find((item) => item.id === projectId);
    const intent = useRef(null);
    const confirmed = useRef(null);

    // Re-read the actual destination even before a catalogue event has caused a render.
    const reviewKey = () => {
        const project = (store.state.projects ?? []).find((item) => item.id === projectId);

        return JSON.stringify([
            accessKey(),
            mode,
            path.trim(),
            leafId.trim(),
            preview?.path,
            preview?.activeId,
            preview?.sha256,
            preview?.leafId,
            preview?.existing,
            preview?.existingTitle,
            preview?.visibility,
            preview?.projectId,
            model,
            thinking,
            sharing,
            projectId,
            project ? [project.name, project.cwd, project.location] : null,
        ]);
    };

    const intentKey = reviewKey();

    latest.current = {
        visible,
        isCurrentOpening,
        isActive,
        onComplete,
        onCreated,
        onBusyChange,
        reviewKey,
        mode,
        preview,
    };
    intent.current = intentKey;
    const requestCurrent = (turn, key) =>
        current() &&
        turn === generation.current &&
        intent.current === key &&
        latest.current.reviewKey() === key;
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

    const reportBusy = (value) => {
        const callback = latest.current.onBusyChange;

        if (
            inScope() &&
            (reportedBusy.current?.callback !== callback || reportedBusy.current?.value !== value)
        ) {
            reportedBusy.current = { callback, value };
            callback?.(value);
        }
    };

    const changeBusy = (value) => {
        setBusy(value);
        reportBusy(value);
    };

    useEffect(() => {
        reportBusy(busy);
    }, [busy, onBusyChange]);

    const clearPreview = () => {
        setPreview(null);
        resetConsent();
        setError("");
    };

    const showPreview = (result) => {
        if (!inScope() || !piSessionsAvailable()) {
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
        if (
            !current() ||
            pending.current ||
            latest.current.mode !== "running" ||
            latest.current.preview
        ) {
            return;
        }

        const turn = ++generation.current;
        const key = intentKey;

        setLoading(true);
        setError("");

        try {
            const result = await api("pi-sessions/active");

            if (requestCurrent(turn, key)) {
                setListing(result);
            }
        } catch (failure) {
            if (requestCurrent(turn, key)) {
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
        if (!current() || busy || pending.current) {
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

        if (next && current() && !busy && !pending.current) {
            event.preventDefault();
            selectSource(next);
            event.currentTarget.querySelector(`#${fieldId(`import-tab-${next}`)}`).focus();
        }
    };

    const choose = async (session, saved = false) => {
        if (
            !current() ||
            latest.current.preview ||
            latest.current.mode !== (saved ? "history" : "running") ||
            pending.current ||
            intent.current !== intentKey ||
            latest.current.reviewKey() !== intentKey
        ) {
            return;
        }

        const turn = ++generation.current;

        pending.current = true;
        changeBusy(true);
        setError("");

        try {
            const result = await api(
                saved ? "pi-sessions/preview" : "pi-sessions/active/preview",
                saved ? { path: session.path } : { id: session.id },
            );

            if (requestCurrent(turn, intentKey)) {
                showPreview(result);
            }
        } catch (failure) {
            if (requestCurrent(turn, intentKey)) {
                setError(failure.message);
            }
        } finally {
            pending.current = false;

            if (alive.current) {
                changeBusy(false);
            }
        }
    };

    const submit = async (event) => {
        event.preventDefault();

        if (
            !current() ||
            intent.current !== intentKey ||
            latest.current.reviewKey() !== intentKey ||
            pending.current ||
            (preview &&
                (!selected ||
                    !acknowledged ||
                    confirmed.current !== intentKey ||
                    (projectId && !chosenProject)))
        ) {
            return;
        }

        const turn = ++generation.current;
        const completing = () => requestCurrent(turn, intentKey);

        pending.current = true;
        changeBusy(true);
        setError("");

        try {
            if (!preview) {
                const result = await api("pi-sessions/preview", {
                    path: path.trim(),
                    ...(leafId.trim() ? { leafId: leafId.trim() } : {}),
                });

                if (completing()) {
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

                if (!completing()) {
                    return;
                }

                notify(
                    "info",
                    result.existing
                        ? "Opened the existing import."
                        : "Saved history copied. The original Pi is unchanged.",
                );

                const { onComplete: complete, onCreated: created } = latest.current;

                if (complete) {
                    complete(result.id);
                } else {
                    closeSheet();
                    navigate(result.id);
                }

                created?.(result.id);
            }
        } catch (failure) {
            if (completing()) {
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
                changeBusy(false);
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
                    id=${fieldId(`import-tab-${source}`)}
                    type="button"
                    role="tab"
                    class=${sourceTab === source ? "on" : ""}
                    aria-selected=${sourceTab === source}
                    aria-controls=${fieldId(`import-panel-${source}`)}
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
            id=${fromPrivate ? undefined : fieldId(`import-panel-${sourceTab}`)}
            role=${fromPrivate ? undefined : "tabpanel"}
            aria-labelledby=${fromPrivate ? undefined : fieldId(`import-tab-${sourceTab}`)}
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
                fieldId=${fieldId}
                isActive=${() =>
                    current() &&
                    latest.current.mode === "history" &&
                    !latest.current.preview &&
                    !pending.current}
                onChoose=${(session) => choose(session, true)}
                onManual=${() => {
                    if (current() && latest.current.mode === "history" && !pending.current) {
                        clearPreview();
                        setMode("file");
                    }
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
                            <label class="label" for=${fieldId("import-path")}>
                                Session file on this server
                            </label>
                            <input
                                id=${fieldId("import-path")}
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
                            <label class="label" for=${fieldId("import-leaf")}>
                                Branch entry ID, optional
                            </label>
                            <input
                                id=${fieldId("import-leaf")}
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
                        html`<section
                        id=${fieldId("import-preview")}
                        aria-label="Import preview"
                    >
                        <h3>${preview.title}</h3>
                        <p class="small import-cwd">${preview.cwd}</p>
                        <p class="small muted">${active ? "Move copies saved history; Pi keeps running." : "Copies saved history without changing the original."} Unfinished work is not resumed here.</p>
                        ${
                            preview.existing !== undefined &&
                            html`<p class="small">Opens existing Chat #${preview.existing}: ${preview.existingTitle ?? "Imported Pi session"}. Sharing publishes its entire current history, including messages added since import, and future messages, not just the source excerpts below.</p>`
                        }
                        <div class="field">
                            <label class="label" for=${fieldId("import-model")}>
                                Destination model
                            </label>
                            <select
                                id=${fieldId("import-model")}
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
                            <label class="label" for=${fieldId("import-thinking")}>
                                Destination thinking level
                            </label>
                            <select
                                id=${fieldId("import-thinking")}
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
                            <label class="label" for=${fieldId("import-visibility")}>
                                Visibility
                            </label>
                            <select
                                id=${fieldId("import-visibility")}
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
                            id=${fieldId("import-project")}
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
                                id=${fieldId("import-consent")}
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
