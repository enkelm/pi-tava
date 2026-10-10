// Running sessions first. The saved-file form remains available for sessions outside local Herdr.
import { useEffect, useRef, useState } from "preact/hooks";
import { api, closeSheet, navigate, notify } from "../store.js";
import { html, Loader, Sheet } from "../ui.js";

export function ImportSheet({ initialPreview = null, fromPrivate = false }) {
    const [mode, setMode] = useState("running");
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
    const [busy, setBusy] = useState(false);
    const [error, setError] = useState("");
    const alive = useRef(true);
    const pending = useRef(false);
    const generation = useRef(0);
    const selected = preview?.models.find((item) => `${item.provider}/${item.id}` === model);
    const active = Boolean(preview?.activeId);
    const sharing = fromPrivate || preview?.visibility === "shared";

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
        if (mode !== "running" || preview || busy) {
            return;
        }

        refresh();
    }, [mode, preview, busy]);

    const clearPreview = () => {
        setPreview(null);
        setAcknowledged(false);
        setStopped(false);
        setError("");
    };

    const showPreview = (result) => {
        setPreview(result);
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

        if (pending.current || invalid || (sharing && (!preview || !acknowledged))) {
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
                    ...(sharing ? { visibility: "shared" } : {}),
                });

                notify(
                    "info",
                    result.existing
                        ? "Opened the existing import."
                        : sharing
                          ? "Imported and shared. The original archive stays owner-only."
                          : "Moved to Durable. The original session file is unchanged.",
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

    return html`<${Sheet} title=${sharing ? "Import & share" : "Import Pi session"} onClose=${closeSheet}>
        ${
            mode === "running" &&
            !preview &&
            html`
            <p>Choose a running Pi to move into Durable.</p>
            <p class="small muted">Local Herdr sessions on this machine. Pi stops; its pane and shell stay open.</p>
            <div class="import-list" aria-label="Running Pi sessions" aria-busy=${loading || busy}>
                ${listing === null && loading && html`<${Loader} label="Finding Pi sessions" />`}
                ${listing?.sessions.length === 0 && html`<p>No running Pi sessions found. Check that Herdr is running with its Pi integration enabled.</p>`}
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
                            <span class="small muted">${session.location} · ${session.state}</span>
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
            <p><button id="import-file-mode" class="link" type="button" disabled=${busy} onClick=${() => {
                clearPreview();
                setMode("file");
            }}>Use a saved session file instead</button></p>
        `
        }
        ${
            (mode === "file" || preview) &&
            html`
        ${
            fromPrivate
                ? html`<button class="link small" type="button" onClick=${closeSheet}>Back to private pane</button>`
                : html`<button class="link small" type="button" disabled=${busy} onClick=${() => {
                      clearPreview();
                      setMode("running");
                  }}>Choose another running session</button>`
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
                ${active && html`<p>Move stops the original Pi in ${preview.location} and continues its last saved branch in Durable. Its terminal stays open.</p>`}
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
                disabled=${busy || invalid || (sharing && !acknowledged) || (mode === "file" && !path.trim()) || (preview && (!selected || (!active && (!stopped || !acknowledged))))}>
                ${busy ? (active ? "Stopping Pi and importing…" : preview ? "Importing…" : "Reading session…") : sharing ? "Import & share" : active ? "Move to Durable" : preview ? "Import and open" : "Preview import"}
            </button>
            ${busy && active && html`<p class="small" role="status">You can close this sheet. The move continues on the server.</p>`}
        </form>`
        }
        ${busy && !preview && mode === "running" && html`<p class="small" role="status">Reading this session…</p>`}
        ${error && html`<p class="error-box" role="alert">${error}</p>`}
    <//>`;
}
