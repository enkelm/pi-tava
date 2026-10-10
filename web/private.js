// Owner-only Herdr. Private transcripts, frames and drafts never enter Durable rooms or storage.
// Private uses GPUI e370bf0 sidebar/render.rs: independent Spaces and Agents, tabs over content.
// Keep Pocket's fonts/tokens. Desktop opens retained Terminal control; phones open agent Chat.
import { useEffect, useLayoutEffect, useMemo, useRef, useState } from "preact/hooks";
import { goHome } from "./back.js";
import { api, navigate, openSheet, store, uid } from "./store.js";
import { html, Icon, Loader, Markdown } from "./ui.js";
import {
    PrivateTerminal,
    useLiveTerminal,
    selectTerminalInstance,
    syncTerminalTargets,
    disconnectPrivateTerminal,
} from "./private-terminal.js";

const owner = () => (store.state.me?.role === "owner" ? store.state.me.id : null);
const awake = () => document.visibilityState !== "hidden" && navigator.onLine !== false;
const pollers = new Set();
const reads = new Map();

// Serialize only read-only Private GETs. Terminal input is never queued.
function readPrivate(path, signal) {
    const preceding = reads.get(path);
    const who = owner();
    const request = (async () => {
        await preceding?.catch(() => {});

        if (signal.aborted || who !== owner()) {
            throw new DOMException("Private read cancelled", "AbortError");
        }

        return api(path, undefined, { signal });
    })();

    reads.set(path, request);
    const complete = request.finally(() => {
        if (reads.get(path) === request) {
            reads.delete(path);
        }
    });
    let cancel;
    const aborted = new Promise((_resolve, reject) => {
        cancel = () => reject(new DOMException("Private read cancelled", "AbortError"));
        signal.addEventListener("abort", cancel, { once: true });

        if (signal.aborted) {
            cancel();
        }
    });

    return Promise.race([complete, aborted]).finally(() =>
        signal.removeEventListener("abort", cancel),
    );
}

const importBlocks = new Map();
const importObservers = new Set();
const updateImportBlocks = () => importObservers.forEach((listener) => listener());
let identity = owner();

/** One request at a time per resource, shared by the sidebar and mobile home list. */
function snapshots(path, interval) {
    let state = { data: null, error: "", paused: !awake() };
    let request = null;
    let timer;
    let epoch = 0;
    const listeners = new Set();
    const emit = () => listeners.forEach((listener) => listener(state));
    const eligible = () => listeners.size > 0 && owner() !== null && awake();

    const reset = () => {
        epoch++;
        clearTimeout(timer);
        request?.abort();
        state = { data: null, error: "", paused: !awake() };
        emit();
    };

    const refresh = async () => {
        clearTimeout(timer);

        if (!eligible() || request) {
            return;
        }

        const controller = new AbortController();
        const turn = epoch;
        const who = owner();
        const timeout = setTimeout(() => controller.abort(), 12000);

        request = controller;

        try {
            const data = await readPrivate(path, controller.signal);

            if (turn === epoch && who === owner() && eligible()) {
                state = { data, error: "", paused: false };
                emit();
            }
        } catch (error) {
            if (turn !== epoch || who !== owner() || !eligible()) {
                return;
            }

            if (error.status === 401 || error.status === 403) {
                reset();
                store.set({
                    me: error.status === 401 ? null : { ...store.state.me, role: "viewer" },
                });

                return;
            }

            // Do not keep showing a previous pane's contents after an unavailable response.
            state = {
                data: null,
                error:
                    error.name === "AbortError" ? "Herdr did not answer in time." : error.message,
                paused: false,
            };
            emit();
        } finally {
            clearTimeout(timeout);
            request = null;

            if (eligible()) {
                timer = setTimeout(refresh, turn === epoch ? interval : 0);
            }
        }
    };

    const wake = () => {
        if (!awake()) {
            epoch++;
            clearTimeout(timer);
            request?.abort();
        }

        state = { ...state, paused: !awake() };
        emit();
        refresh();
    };

    const resource = {
        reset,
        refresh,
        subscribe(listener) {
            listeners.add(listener);
            listener(state);

            if (listeners.size === 1) {
                pollers.add(resource);
                document.addEventListener("visibilitychange", wake);
                window.addEventListener("online", wake);
                window.addEventListener("offline", wake);
                refresh();
            }

            return () => {
                listeners.delete(listener);

                if (listeners.size === 0) {
                    reset();
                    pollers.delete(resource);
                    document.removeEventListener("visibilitychange", wake);
                    window.removeEventListener("online", wake);
                    window.removeEventListener("offline", wake);
                }
            };
        },
    };

    return resource;
}

store.subscribe(() => {
    const next = owner();

    if (next !== identity) {
        identity = next;
        importBlocks.clear();
        reads.clear();
        updateImportBlocks();
        pollers.forEach((resource) => resource.reset());

        if (store.state.sheet?.fromPrivate) {
            store.set({ sheet: null });
        }

        pollers.forEach((resource) => resource.refresh());
    }
});

const listing = snapshots("private", 4000);

function useSnapshots(resource, enabled = true) {
    const [state, setState] = useState({ data: null, error: "", paused: !awake() });

    useLayoutEffect(() => {
        if (enabled) {
            return resource.subscribe(setState);
        }

        setState({ data: null, error: "", paused: !awake() });
    }, [resource, enabled]);

    return state;
}

export function PrivateTabs() {
    if (owner() === null) {
        return null;
    }

    return html`<div class="session-tabs private-tabs" role="tablist" aria-label="Session source">
        ${[
            ["sessions", "Sessions"],
            ["private", "Private"],
        ].map(
            ([key, label]) => html`<button
            role="tab"
            aria-selected=${store.state.sidebarTab === key}
            class=${store.state.sidebarTab === key ? "on" : ""}
            onClick=${() => store.set({ sidebarTab: key })}
        >${label}</button>`,
        )}
    </div>`;
}

function useDesktop() {
    const [wide, setWide] = useState(() => matchMedia("(min-width: 960px)").matches);

    useEffect(() => {
        const query = matchMedia("(min-width: 960px)");
        const change = () => setWide(query.matches);

        query.addEventListener("change", change);

        return () => query.removeEventListener("change", change);
    }, []);

    return wide;
}

function places(data) {
    return (data?.instances || []).flatMap((instance) =>
        instance.workspaces.map((workspace) => ({
            instance,
            workspace,
            panes: workspace.tabs.flatMap((tab) => tab.panes.map((pane) => ({ pane, tab }))),
        })),
    );
}

const shortLabel = (value, fallback) => value?.replace(/\/$/, "").split("/").pop() || fallback;

const keepTerminalFocus = (event) => {
    if (
        matchMedia("(min-width: 960px)").matches &&
        document.activeElement?.matches(".terminal-grid-input")
    ) {
        event.preventDefault();
    }
};

const pickPane = (workspace) => {
    const tab = workspace.tabs.find((item) => item.active) || workspace.tabs[0];

    return tab?.panes.find((pane) => pane.active) || tab?.panes[0];
};

function Status({ state }) {
    return html`<span class=${`private-status ${["idle", "working", "busy", "waiting", "error"].includes(state) ? state : ""}`} title=${state || "unknown"} aria-label=${state || "unknown"}></span>`;
}

export function PrivateList({ compact = false, home = false }) {
    const wide = useDesktop();
    const visible = compact || (home ? !wide : wide);
    const { data, error, paused } = useSnapshots(listing, visible);
    const live = useLiveTerminal();
    const [importing, setImporting] = useState(null);
    const [notice, setNotice] = useState("");
    const [, setImportRevision] = useState(0);
    const importOperation = useRef(null);

    useEffect(() => syncTerminalTargets(data), [data]);
    useLayoutEffect(() => {
        const update = () => setImportRevision((value) => value + 1);

        importObservers.add(update);

        return () => {
            importObservers.delete(update);
            importOperation.current?.abort();
        };
    }, []);

    const importPane = async (pane, instance) => {
        if (importOperation.current || importBlocks.get(pane.id) || !awake() || owner() === null) {
            return;
        }

        const who = owner();
        const controller = new AbortController();
        const current = () => who === owner() && !controller.signal.aborted && awake();
        const timeout = setTimeout(() => controller.abort(), 15000);
        const availabilityTimeout = setTimeout(() => controller.abort(), 3000);
        let importReason = "";

        importOperation.current = controller;
        setImporting(pane.id);
        setNotice("");
        // Import is a new explicit action: detach our view and suppress its reconnect first.
        disconnectPrivateTerminal(instance.id);

        try {
            const until = Date.now() + 3000;
            let view;

            do {
                view = await readPrivate(
                    `private/${encodeURIComponent(pane.id)}`,
                    controller.signal,
                );

                importReason = view.canImport
                    ? ""
                    : view.importReason ||
                      view.reason ||
                      "This agent has no verified session available to import.";

                if (view.canImport || Date.now() >= until || !current()) {
                    break;
                }

                await new Promise((resolve) => setTimeout(resolve, 120));
            } while (current());

            clearTimeout(availabilityTimeout);

            if (controller.signal.aborted) {
                throw new DOMException("Import availability timed out", "AbortError");
            }

            if (!current()) {
                return;
            }

            if (!view.canImport) {
                const reason =
                    view.importReason ||
                    view.reason ||
                    "This agent has no verified session available to import.";

                setNotice(
                    /attached|detach|disconnect/i.test(reason)
                        ? reason +
                              " Disconnect other web Terminals for this instance, then try again."
                        : reason,
                );

                return;
            }

            const preview = await api(
                `private/${encodeURIComponent(pane.id)}/import-preview`,
                { revision: view.revision },
                { signal: controller.signal },
            );

            if (current()) {
                openSheet({ type: "import", fromPrivate: true, initialPreview: preview });
            }
        } catch (error) {
            if (who === owner()) {
                setNotice(
                    error.name === "AbortError"
                        ? /attached|detach|disconnect/i.test(importReason)
                            ? importReason +
                              " Disconnect other web Terminals for this instance, then try again."
                            : importReason || "Import preparation timed out. Nothing was shared."
                        : error.message,
                );

                if (error.status === 401 || error.status === 403) {
                    store.set({
                        me: error.status === 401 ? null : { ...store.state.me, role: "viewer" },
                    });
                }
            }
        } finally {
            clearTimeout(timeout);
            clearTimeout(availabilityTimeout);
            importOperation.current = null;

            if (who === owner()) {
                setImporting(null);
            }
        }
    };

    const workspaces = places(data);
    const agents = workspaces.flatMap((place) =>
        place.panes.filter(({ pane }) => pane.agent).map((entry) => ({ ...entry, ...place })),
    );

    return html`<div class="session-items private-list" aria-label="Private Herdr panes">
        ${paused && html`<p class="private-hint small" role="status">Updates paused while offline or hidden.</p>`}
        ${error && html`<p class="error-box" role="alert">${error} Reconnecting to Herdr…</p>`}
        ${!data && !error && !paused && html`<${Loader} label="Finding Herdr instances" />`}
        ${data?.warnings?.map((warning) => html`<p class="error-box small">${warning}</p>`)}
        <section class="private-spaces" aria-label="Spaces">
            <h2 class="private-section-title">Spaces</h2>
            <div class="private-section-scroll">
                ${data?.instances.length === 0 && html`<p class="private-hint small muted">No Herdr instances found. Open Herdr on this server to see its spaces here.</p>`}
                ${data?.instances.map(
                    (instance) => html`<div key=${instance.id} class="private-host">
                    ${data.instances.length > 1 && html`<div class="private-host-label">${shortLabel(instance.label, "Local")}</div>`}
                    ${
                        !instance.available
                            ? html`<p class="private-hint small error-box">Unavailable. ${instance.error || "Herdr is not answering."}</p>`
                            : instance.workspaces.length === 0
                              ? html`<p class="private-hint small muted">No workspaces.</p>`
                              : instance.workspaces.map((workspace) => {
                                    const panes = workspace.tabs.flatMap((tab) => tab.panes);
                                    const native =
                                        live?.view === "terminal" &&
                                        live.instanceId === instance.id &&
                                        workspace.nativeId;
                                    const selected = native
                                        ? live.snapshot.focused_workspace_id === workspace.nativeId
                                        : panes.some((pane) => pane.id === store.state.privateId);
                                    const first = pickPane(workspace);

                                    return html`<button
                                  key=${workspace.id}
                                  class=${`private-space-row ${selected ? "active" : ""}`}
                                  aria-current=${selected ? "location" : undefined}
                                  title=${workspace.label}
                                  disabled=${!first && !native}
                                  onPointerDown=${keepTerminalFocus}
                                  onClick=${() => (native ? live.request("workspace.focus", { workspace_id: workspace.nativeId }) : navigate(null, { privateId: first.id }))}
                              >
                                  <${Status} state=${workspace.state || first?.state} />
                                  <span class="private-row-copy">
                                      <span class="session-title">${shortLabel(workspace.label, "Workspace")}</span>
                                      ${workspace.branch && html`<span class="session-meta">${workspace.branch}</span>`}
                                  </span>
                                  <span class="private-row-count" title="Tabs">${workspace.tabs.length}</span>
                              </button>`;
                                })
                    }
                </div>`,
                )}
            </div>
        </section>
        <section class="private-agents" aria-label="Agents">
            <h2 class="private-section-title">Agents <span>${agents.length}</span></h2>
            <div class="private-section-scroll">
                ${data && !agents.length && html`<p class="private-hint small muted">No agents. Open a space to use its terminals.</p>`}
                ${agents.map(({ pane, workspace, tab, instance }) => {
                    const native =
                        live?.view === "terminal" &&
                        live.instanceId === instance.id &&
                        pane.nativeId;
                    const selected = native
                        ? live.snapshot.focused_pane_id === pane.nativeId
                        : store.state.privateId === pane.id;
                    const supported =
                        pane.supportsImport === true ||
                        (pane.supportsImport === undefined && pane.agent === "pi");

                    return html`<div key=${pane.id} class=${`private-agent-row ${selected ? "active" : ""}`}>
                    <button
                        class=${`private-pane-row ${selected ? "active" : ""}`}
                        aria-current=${selected ? "page" : undefined}
                        title=${pane.title}
                        onPointerDown=${keepTerminalFocus}
                        onClick=${() => (native ? live.request("pane.focus", { pane_id: pane.nativeId }) : navigate(null, { privateId: pane.id }))}
                    >
                        <${Status} state=${pane.state} />
                        <span class="private-row-copy">
                            <span class="private-agent-place"><strong>${shortLabel(workspace.label, "Workspace")}</strong><span>${shortLabel(tab.label, "Tab")}</span></span>
                            <span class="session-meta">${pane.agent} · ${pane.state}</span>
                        </span>
                    </button>
                    ${supported && html`<button class="icon-button private-import" aria-label=${`Import & share ${shortLabel(pane.title, "agent")}`} title=${importBlocks.get(pane.id) ? "Import is blocked while prompt delivery is pending or uncertain" : "Import & share — disconnects this browser’s terminal first"} disabled=${Boolean(importing) || importBlocks.get(pane.id)} onClick=${() => importPane(pane, instance)}><${Icon} name=${importing === pane.id ? "pulse" : "external"} size=${15} /></button>`}
                    </div>`;
                })}
            </div>
        </section>
        <p class="private-list-footer small muted" role="status" title=${notice || undefined}>${notice || html`<${Icon} name="terminal" size=${14} /> Only you · Herdr`}</p>
    </div>`;
}

function Entry({ entry }) {
    if (entry.kind === "assistant") {
        return html`<article class="private-entry">
            <div class="private-speaker muted">Pi</div>
            ${entry.blocks.map((block, index) =>
                block.type === "text"
                    ? html`<${Markdown} key=${index} text=${block.text} readOnly=${true} />`
                    : html`<details key=${index} class="private-tool">
                    <summary>${block.type === "thinking" ? "Thinking" : block.name}</summary>
                    <pre>${block.type === "thinking" ? block.text : JSON.stringify(block.args, null, 2)}</pre>
                </details>`,
            )}
            ${entry.error && html`<p class="error-box">${entry.error}</p>`}
        </article>`;
    }

    if (entry.kind === "toolResult") {
        return html`<details class="private-tool">
            <summary>${entry.name}${entry.isError ? " · failed" : " · result"}</summary>
            <pre>${entry.text}</pre>
            ${entry.clipped && html`<p class="small muted">Output clipped in this snapshot.</p>`}
        </details>`;
    }

    return html`<article class=${`private-entry ${entry.kind === "user" ? "private-user" : ""}`}>
        <div class="private-speaker muted">${entry.kind === "user" ? entry.from || "You" : entry.name || entry.kind}</div>
        <${Markdown} text=${entry.text || entry.summary || ""} readOnly=${true} />
        ${entry.images > 0 && html`<p class="small muted">${entry.images} image(s) in saved history, not shown in this mirror.</p>`}
    </article>`;
}

export function PrivatePane({ id }) {
    const wide = useDesktop();
    const { data } = useSnapshots(listing);
    const [choice, setChoice] = useState(null);
    const live = useLiveTerminal();
    const remembered = useRef(null);
    const currentPlace = places(data).find((item) => item.panes.some(({ pane }) => pane.id === id));

    if (currentPlace) {
        remembered.current = { id, place: currentPlace };
    }

    const place = currentPlace || (remembered.current?.id === id ? remembered.current.place : null);
    const selected = place?.panes.find(({ pane }) => pane.id === id);
    const mode = choice || (wide || !selected?.pane.agent ? "terminal" : "chat");
    const liveSnapshot =
        mode === "terminal" && live?.instanceId === place?.instance.id ? live?.snapshot : null;

    useEffect(() => {
        syncTerminalTargets(data);
        selectTerminalInstance(place?.instance.id);
    }, [data, place?.instance.id]);
    const tabs = liveSnapshot
        ? liveSnapshot.tabs
              .filter((tab) => tab.workspace_id === liveSnapshot.focused_workspace_id)
              .map((tab) => ({ ...tab, id: tab.tab_id, nativeId: tab.tab_id, panes: [true] }))
        : place?.workspace.tabs || [];
    const panes = selected?.tab.panes || [];

    return html`<header class="topbar private-workspace-bar">
        <button class="icon-button" aria-label="Back to private panes" onClick=${() => goHome(() => navigate(null, { replace: true }))}>
            <${Icon} name="back" size=${20} />
        </button>
        <div class="title"><div class="title-main">${shortLabel(liveSnapshot?.workspaces.find((workspace) => workspace.workspace_id === liveSnapshot.focused_workspace_id)?.label || place?.workspace.label, "Private")}</div><div class="title-sub">Only you · Herdr</div></div>
        <div class="private-view-switch" role="group" aria-label="Private view">
            <button aria-pressed=${mode === "terminal"} onClick=${() => setChoice("terminal")}>Terminal</button>
            <button aria-pressed=${mode === "chat"} onClick=${() => {
                const target = places(data)
                    .flatMap((item) => item.panes)
                    .find(({ pane }) => pane.nativeId === liveSnapshot?.focused_pane_id)?.pane;

                setChoice("chat");

                if (target && target.id !== id) {
                    navigate(null, { privateId: target.id });
                }
            }}>Chat</button>
        </div>
    </header>
    ${
        tabs.length > 0 &&
        html`<nav class="private-tabbar" aria-label="Workspace tabs">
        ${tabs.map(
            (tab) => html`<button
            key=${tab.id}
            aria-current=${(liveSnapshot ? liveSnapshot.focused_tab_id === tab.nativeId : selected?.tab.id === tab.id) ? "page" : undefined}
            disabled=${!tab.panes.length}
            title=${tab.label}
            onPointerDown=${keepTerminalFocus}
            onClick=${() => (liveSnapshot ? live.request("tab.focus", { tab_id: tab.nativeId }) : navigate(null, { privateId: (tab.panes.find((pane) => pane.active) || tab.panes[0]).id }))}
        >${shortLabel(tab.label, "Tab")}</button>`,
        )}
    </nav>`
    }
    ${
        mode === "chat" &&
        panes.length > 1 &&
        html`<nav class="private-pane-picker" aria-label="Tab panes">
        ${panes.map((pane) => html`<button aria-current=${pane.id === id ? "page" : undefined} onClick=${() => navigate(null, { privateId: pane.id })}>${shortLabel(pane.title, pane.agent || "Shell")}</button>`)}
    </nav>`
    }
    ${place && html`<${PrivatePaneView} key=${place.instance.id} id=${id} nativeId=${selected?.pane.nativeId} instanceId=${place.instance.id} mode=${mode} />`}`;
}

function PrivatePaneView({ id, mode, instanceId, nativeId }) {
    const resource = useMemo(() => snapshots(`private/${encodeURIComponent(id)}`, 2000), [id]);
    const { data, error, paused } = useSnapshots(resource);
    const [draft, setDraft] = useState("");
    const [draftRevision, setDraftRevision] = useState(null);
    const [pending, setPending] = useState("");
    const [message, setMessage] = useState("");
    const [uncertain, setUncertain] = useState(false);
    const uncertainRevision = useRef(null);
    const operation = useRef(null);
    const mounted = useRef(true);
    const transcript = useRef(null);
    const terminal = useRef(null);
    const followTranscript = useRef(true);
    const followTerminal = useRef(true);
    const stale = Boolean(
        draft && draftRevision !== null && data && draftRevision !== data.revision,
    );
    const usable = data && !error && !paused && awake();
    const canSend = usable && data.canPrompt && !pending && !stale && !uncertain && draft.trim();

    useLayoutEffect(() => {
        setDraft("");
        setDraftRevision(null);
        setPending("");
        setMessage("");
        setUncertain(false);
        uncertainRevision.current = null;
        followTranscript.current = true;
        followTerminal.current = true;
        operation.current = null;

        return () => operation.current?.abort();
    }, [id]);

    useLayoutEffect(() => {
        importBlocks.set(id, Boolean(pending) || uncertain);
        updateImportBlocks();

        return () => {
            importBlocks.delete(id);
            updateImportBlocks();
        };
    }, [id, pending, uncertain]);

    useLayoutEffect(
        () => () => {
            mounted.current = false;
            operation.current?.abort();
        },
        [],
    );

    // Open at the latest work. Polls only follow while the reader has stayed near the bottom.
    useLayoutEffect(() => {
        if (followTerminal.current && terminal.current) {
            terminal.current.scrollTop = terminal.current.scrollHeight;
        }

        if (followTranscript.current && transcript.current) {
            transcript.current.scrollTop = transcript.current.scrollHeight;
        }
    }, [data]);

    useEffect(() => {
        // A new verified revision can lift the local block after a server restart. The draft's
        // old revision still requires explicit review; observing a snapshot never sends it.
        if (uncertain && data?.canPrompt && data.revision !== uncertainRevision.current) {
            setUncertain(false);
            setMessage(
                "Pi's session changed. Review the current session and your draft before sending.",
            );
        }
    }, [data, uncertain]);

    const trackScroll = (ref) => (event) => {
        const box = event.currentTarget;

        ref.current = box.scrollHeight - box.clientHeight - box.scrollTop < 80;
    };

    const act = async (kind) => {
        if (
            operation.current ||
            !usable ||
            (kind === "prompt" && !canSend) ||
            (kind === "import-preview" && (!data.canImport || uncertain))
        ) {
            return;
        }

        const controller = new AbortController();
        const who = owner();
        const current = () =>
            mounted.current && who !== null && who === owner() && store.state.privateId === id;
        const timeout = setTimeout(() => controller.abort(), 15000);

        operation.current = controller;
        setPending(kind);
        setMessage("");

        try {
            const result = await api(
                `private/${encodeURIComponent(id)}/${kind}`,
                {
                    revision: kind === "prompt" ? draftRevision : data.revision,
                    ...(kind === "prompt" ? { text: draft.trim(), requestId: uid() } : {}),
                },
                { signal: controller.signal },
            );

            if (!current()) {
                return;
            }

            if (kind === "prompt") {
                if (result.sent !== true) {
                    throw new Error("Delivery was not confirmed.");
                }

                setDraft("");
                setDraftRevision(null);
                setMessage("Sent to Pi in Herdr. Check the terminal for live output.");
            } else {
                openSheet({ type: "import", fromPrivate: true, initialPreview: result });
            }

            resource.refresh();
        } catch (failure) {
            if (!current()) {
                return;
            }

            if (failure.status === 401 || failure.status === 403) {
                store.set({
                    me: failure.status === 401 ? null : { ...store.state.me, role: "viewer" },
                });

                return;
            }

            if (kind === "prompt" && failure.status !== 409 && failure.status !== 400) {
                uncertainRevision.current = data.revision;
                setUncertain(true);
                setMessage(
                    "Delivery is uncertain. Check the terminal in Herdr before sending again. Import stays blocked until delivery is resolved. This prompt will not be retried automatically.",
                );
            } else {
                setMessage(
                    failure.status === 409
                        ? "The pane changed or Pi is busy. Review the latest snapshot before trying again. Your draft is kept."
                        : failure.message,
                );
            }

            resource.refresh();
        } finally {
            clearTimeout(timeout);

            if (operation.current === controller) {
                operation.current = null;
            }

            if (current()) {
                setPending("");
            }
        }
    };

    return html`    ${
        mode === "terminal"
            ? html`<${PrivateTerminal} id=${id} nativeId=${nativeId} instanceId=${instanceId} statusError=${error} fallback=${data?.terminal || ""} available=${Boolean(usable)} />`
            : html`<div
        class="scroller private-transcript"
        aria-label="Private pane mirror"
        ref=${transcript}
        onScroll=${trackScroll(followTranscript)}
    >
        ${error && html`<p class="error-box" role="alert">${error} Reconnecting to Herdr…</p>`}
        ${paused && html`<p class="error-box" role="status">Snapshot paused. Updates resume when this page is visible and online.</p>`}
        ${!data && !error && !paused && html`<${Loader} label="Reading private pane" />`}
        ${
            data &&
            html`
            <p class="small muted private-cwd">${data.pane.cwd}</p>
            <p class="small muted">Saved messages from Pi's session file. The terminal snapshot below shows live output.</p>
            ${data.warnings?.map((warning) => html`<p class="error-box small">${warning}</p>`)}
            ${data.entries.map((entry) => html`<${Entry} key=${`${data.revision}:${entry.id}`} entry=${entry} />`)}
            ${data.entries.length === 0 && html`<p class="muted">No saved messages. This pane is shown through its terminal snapshot.</p>`}
            <section class="private-terminal" aria-label="Terminal snapshot">
                <h3>Terminal snapshot</h3>
                <p class="small muted">Captured ${new Date(data.capturedAt).toLocaleTimeString()}. Read-only.</p>
                <pre
                    tabindex="0"
                    ref=${terminal}
                    onScroll=${trackScroll(followTerminal)}
                >${data.terminal || "No terminal output in this snapshot."}</pre>
            </section>
        `
        }
    </div>
    <form class="private-composer" onSubmit=${(event) => {
        event.preventDefault();
        act("prompt");
    }}>
        ${data && !data.canPrompt && html`<p class="small muted">${data.reason || "This pane is read-only. Prompting is available only for a verified idle Pi."}</p>`}
        ${
            stale &&
            html`<p class="error-box" role="alert">The Pi session in this pane changed. Your draft has not been sent.</p>
            <button class="button small" type="button" onClick=${() => {
                setDraftRevision(data.revision);
                setMessage("Draft kept for the current session. Review it before sending.");
            }}>Use draft for current session</button>`
        }
        ${
            (data?.canPrompt || draft) &&
            html`<label class="label" for="private-prompt">Prompt Pi in Herdr</label>
            <textarea id="private-prompt" rows="2" value=${draft} disabled=${Boolean(pending)}
                placeholder="Send to this Pi, not Durable"
                onInput=${(event) => {
                    const text = event.currentTarget.value;

                    if (!draft || !text) {
                        setDraftRevision(data?.revision ?? null);
                    }

                    setDraft(text);
                }}></textarea>
            <button class="button primary small" type="submit" disabled=${!canSend}>${pending === "prompt" ? "Sending…" : "Send to Pi"}</button>`
        }
        ${message && html`<p class=${`small ${uncertain ? "error-box" : "muted"}`} role="status">${message}</p>`}
    </form>`
    }`;
}
