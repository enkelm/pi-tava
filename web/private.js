// Owner-only Herdr. Private transcripts, frames and drafts never enter Durable rooms or storage.
// Private uses GPUI e370bf0 sidebar/render.rs: independent Spaces and Agents, tabs over content.
// Keep Pocket's fonts/tokens. Desktop opens retained Terminal control; phones open agent Chat.
import { useEffect, useLayoutEffect, useMemo, useRef, useState } from "preact/hooks";
import { goHome } from "./back.js";
import { api, navigate, openSheet, store, uid } from "./store.js";
import { html, Icon, Loader, modelLabel } from "./ui.js";
import { MessageBox, SendButton } from "./message-box.js";
import {
    privateCommands,
    PrivateModelPicker,
    PrivateAttachmentChips,
    usePrivateAttachments,
} from "./private-input.js";
import { TranscriptEntry } from "./transcript.js";
import {
    PrivateTerminal,
    useLiveTerminal,
    selectTerminalInstance,
    syncTerminalTargets,
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

// Native frames have fresher labels/branches and may include newly opened spaces before GET refreshes.
function liveWorkspaces(instance, live) {
    if (live?.view !== "terminal" || live.instanceId !== instance.id) {
        return instance.workspaces;
    }

    const native = new Map(live.snapshot.workspaces.map((row) => [row.workspace_id, row]));
    const known = new Set(instance.workspaces.map((workspace) => workspace.nativeId));
    const extra = live.snapshot.workspaces
        .filter((row) => !known.has(row.workspace_id))
        .map((row) => ({ id: `native:${row.workspace_id}`, nativeId: row.workspace_id, tabs: [] }));

    return [...instance.workspaces, ...extra].map((workspace) => {
        const row = native.get(workspace.nativeId);

        if (!row) {
            return workspace;
        }

        return {
            ...workspace,
            label: row.label || workspace.label,
            branch: row.branch || "",
            customLabel: row.custom_label,
            state: row.agent_status || workspace.state,
            tabCount: live.snapshot.tabs.filter((tab) => tab.workspace_id === row.workspace_id)
                .length,
            worktree: row.worktree
                ? {
                      key: row.worktree.key,
                      label: row.worktree.label,
                      isLinkedWorktree: row.worktree.is_linked_worktree,
                  }
                : undefined,
        };
    });
}

// Match Herdr sidebar/workspaces.rs: daemon membership, earliest group position, parents before children.
// Orphan worktrees and other primary checkouts stay visible; groups never cross instance boundaries.
function workspaceGroups(workspaces) {
    const repositories = new Map();

    for (const workspace of workspaces) {
        const tree = workspace.worktree;

        if (!tree?.key || typeof tree.isLinkedWorktree !== "boolean") {
            continue;
        }

        if (!repositories.has(tree.key)) {
            repositories.set(tree.key, { key: tree.key, parents: [], children: [] });
        }

        const group = repositories.get(tree.key);

        (tree.isLinkedWorktree ? group.children : group.parents).push(workspace);
    }

    const emitted = new Set();
    const groups = [];

    for (const workspace of workspaces) {
        const group = repositories.get(workspace.worktree?.key);

        if (!group?.parents.length || !group.children.length) {
            groups.push({ parents: [workspace], children: [] });
        } else if (!emitted.has(group.key)) {
            groups.push(group);
            emitted.add(group.key);
        }
    }

    return groups;
}

function WorkspaceRow({ workspace, instance, live, child = false, group, folded, toggle, state }) {
    const panes = workspace.tabs.flatMap((tab) => tab.panes);
    const native =
        live?.view === "terminal" && live.instanceId === instance.id && workspace.nativeId;
    const selected = native
        ? live.snapshot.focused_workspace_id === workspace.nativeId
        : panes.some((pane) => pane.id === store.state.privateId);
    const first = pickPane(workspace);
    const title =
        (child && !workspace.customLabel && workspace.branch) || workspace.label || "Workspace";
    const childrenId = `worktrees-${instance.id}-${group?.parents[0].id}`;

    return html`<div class=${`private-space-item ${child ? "private-worktree-item" : ""}`}>
        <button
            class=${`private-space-row ${selected ? "active" : ""}`}
            data-workspace-id=${workspace.nativeId || workspace.id}
            aria-current=${selected ? "location" : undefined}
            title=${workspace.branch && workspace.branch !== title ? `${title} · ${workspace.branch}` : title}
            disabled=${!first && !native}
            onPointerDown=${keepTerminalFocus}
            onClick=${() => (native ? live.request("workspace.focus", { workspace_id: workspace.nativeId }) : navigate(null, { privateId: first.id }))}
        >
            <${Status} state=${state || workspace.state || first?.state} />
            <span class="private-row-copy">
                <span class="session-title">${title}</span>
                ${!child && workspace.branch && html`<span class="session-meta">${workspace.branch}</span>`}
            </span>
            <span class="private-row-count" title="Tabs">${workspace.tabCount ?? workspace.tabs.length}</span>
        </button>
        ${
            group &&
            html`<button
            class="private-worktree-toggle icon-button"
            aria-label=${`${folded ? "Expand" : "Collapse"} worktrees for ${workspace.label}`}
            aria-expanded=${!folded}
            aria-controls=${childrenId}
            title=${`${folded ? "Expand" : "Collapse"} ${group.children.length} worktrees`}
            onPointerDown=${keepTerminalFocus}
            onClick=${toggle}
        ><${Icon} name="chevron" size=${13} /></button>`
        }
    </div>`;
}

function Status({ state }) {
    return html`<span class=${`private-status ${["idle", "done", "working", "busy", "waiting", "blocked", "error"].includes(state) ? state : ""}`} title=${state || "unknown"} aria-label=${state || "unknown"}></span>`;
}

export function PrivateList({ compact = false, home = false }) {
    const wide = useDesktop();
    const visible = compact || (home ? !wide : wide);
    const { data, error, paused } = useSnapshots(listing, visible);
    const live = useLiveTerminal();
    const [importing, setImporting] = useState(null);
    const [notice, setNotice] = useState("");
    const [collapsed, setCollapsed] = useState(() => new Set());
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

    const importPane = async (pane) => {
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

                setNotice(reason);

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
                        ? importReason || "Import preparation timed out. Nothing was shared."
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
                            : liveWorkspaces(instance, live).length === 0
                              ? html`<p class="private-hint small muted">No workspaces.</p>`
                              : workspaceGroups(liveWorkspaces(instance, live)).map((group) => {
                                    const key = JSON.stringify([instance.id, group.key]);
                                    const folded = collapsed.has(key);
                                    const toggle = () =>
                                        setCollapsed((previous) => {
                                            const next = new Set(previous);

                                            if (next.has(key)) {
                                                next.delete(key);
                                            } else {
                                                next.add(key);
                                            }

                                            return next;
                                        });
                                    const priority = [
                                        "shell",
                                        "unknown",
                                        "done",
                                        "idle",
                                        "working",
                                        "busy",
                                        "waiting",
                                        "blocked",
                                        "error",
                                    ];
                                    const state = folded
                                        ? [...group.parents, ...group.children]
                                              .map(
                                                  (workspace) =>
                                                      workspace.state || pickPane(workspace)?.state,
                                              )
                                              .sort(
                                                  (a, b) =>
                                                      priority.indexOf(b) - priority.indexOf(a),
                                              )[0]
                                        : undefined;

                                    return html`<div key=${group.key || group.parents[0].id} class="private-repo-group">
                                        ${group.parents.map(
                                            (workspace) => html`<${WorkspaceRow}
                                            key=${workspace.id}
                                            workspace=${workspace}
                                            instance=${instance}
                                            live=${live}
                                            group=${group.children.length ? group : undefined}
                                            folded=${folded}
                                            toggle=${toggle}
                                            state=${state}
                                        />`,
                                        )}
                                        ${
                                            group.children.length > 0 &&
                                            html`<div
                                            id=${`worktrees-${instance.id}-${group.parents[0].id}`}
                                            class="private-worktree-children"
                                            hidden=${folded}
                                        >
                                            ${
                                                !folded &&
                                                group.children.map(
                                                    (workspace) => html`<${WorkspaceRow}
                                                key=${workspace.id}
                                                workspace=${workspace}
                                                instance=${instance}
                                                live=${live}
                                                child=${true}
                                            />`,
                                                )
                                            }
                                        </div>`
                                        }
                                    </div>`;
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
                    ${supported && html`<button class="icon-button private-import" aria-label=${`Import & share ${shortLabel(pane.title, "agent")}`} title=${importBlocks.get(pane.id) ? "Import is blocked while prompt delivery is pending or uncertain" : "Import & share — running operations need confirmation"} disabled=${Boolean(importing) || importBlocks.get(pane.id)} onClick=${() => importPane(pane)}><${Icon} name=${importing === pane.id ? "pulse" : "external"} size=${15} /></button>`}
                    </div>`;
                })}
            </div>
        </section>
        <p class="private-list-footer small muted" role="status" title=${notice || undefined}>${notice || html`<${Icon} name="terminal" size=${14} /> Only you · Herdr`}</p>
    </div>`;
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
    ${place && html`<${PrivatePaneView} key=${place.instance.id} id=${id} nativeId=${selected?.pane.nativeId} instanceId=${place.instance.id} mode=${mode} onTerminal=${() => setChoice("terminal")} />`}`;
}

function PrivatePaneView({ id, mode, instanceId, nativeId, onTerminal }) {
    const resource = useMemo(() => snapshots(`private/${encodeURIComponent(id)}`, 2000), [id]);
    const { data, error, paused } = useSnapshots(resource);
    const [draft, setDraft] = useState("");
    const [draftRevision, setDraftRevision] = useState(null);
    const [pending, setPending] = useState("");
    const [message, setMessage] = useState("");
    const [uncertain, setUncertain] = useState(false);
    const [modelOpen, setModelOpen] = useState(false);
    const [modelQuery, setModelQuery] = useState("");
    const [modelCheck, setModelCheck] = useState(null);
    const [commandPick, setCommandPick] = useState(0);
    const [hideCommands, setHideCommands] = useState(false);
    const attachments = usePrivateAttachments(id);
    const filePicker = useRef(null);
    const commandList = useRef(null);
    const uncertainRevision = useRef(null);
    const operation = useRef(null);
    const mounted = useRef(true);
    const transcript = useRef(null);
    const terminal = useRef(null);
    const prompt = useRef(null);
    const followTranscript = useRef(true);
    const followTerminal = useRef(true);
    const stale = Boolean(
        (draft || attachments.files.length) &&
        draftRevision !== null &&
        data &&
        draftRevision !== data.revision,
    );
    const usable = data && !error && !paused && awake();
    const canAct = usable && data.canPrompt && !pending && !stale && !uncertain && !modelCheck;
    const canSend =
        canAct &&
        attachments.files.every((file) => file.state === "done") &&
        (draft.trim() || attachments.files.length > 0);
    const suggestions = hideCommands ? [] : privateCommands(draft);
    const chosen = suggestions[Math.min(commandPick, suggestions.length - 1)];
    const model = data?.model;
    const modelName = store.state.models.find(
        (item) => item.provider === model?.provider && item.id === model?.modelId,
    )?.name;

    const closeModel = () => {
        setModelOpen(false);
        prompt.current?.focus({ preventScroll: true });
    };

    const openModel = (query = "") => {
        if (canAct) {
            setModelQuery(query);
            setModelOpen(true);
            setHideCommands(true);
        }
    };

    const addFiles = (files) => {
        if (!canAct || !files.length) {
            return;
        }

        if (!draft && !attachments.files.length) {
            setDraftRevision(data.revision);
        }

        attachments.add(files, data.revision, setMessage);
    };

    const chooseCommand = (command) => {
        if (!canAct) {
            return;
        }

        if (command.name === "model") {
            openModel();
        } else {
            setDraft(`/${command.name}${command.name.endsWith(":") ? "" : " "}`);
            setDraftRevision(data?.revision ?? null);
            setHideCommands(true);
            prompt.current?.focus();
        }
    };

    useLayoutEffect(() => {
        setDraft("");
        setDraftRevision(null);
        setPending("");
        setMessage("");
        setUncertain(false);
        setModelOpen(false);
        setModelCheck(null);
        setCommandPick(0);
        setHideCommands(false);
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

    useEffect(() => {
        if (!modelCheck || !data) {
            return;
        }

        if (data.revision !== modelCheck.revision) {
            setModelCheck(null);
        } else if (
            data.model?.provider === modelCheck.provider &&
            data.model?.modelId === modelCheck.modelId
        ) {
            setModelCheck(null);
            setMessage(`Saved model: ${modelLabel({ model: data.model, modelName })}.`);
        }
    }, [data, modelCheck, modelName]);

    useEffect(() => {
        commandList.current?.querySelector(".command.on")?.scrollIntoView({ block: "nearest" });
    }, [commandPick]);

    const trackScroll = (ref) => (event) => {
        const box = event.currentTarget;

        ref.current = box.scrollHeight - box.clientHeight - box.scrollTop < 80;
    };

    const act = async (kind, command, pickedModel) => {
        if (
            operation.current ||
            !usable ||
            (kind === "prompt" && !(command ? canAct : canSend)) ||
            (kind === "import-preview" && (!data.canImport || uncertain))
        ) {
            return;
        }

        if (kind === "prompt" && !command && /^\/model(?:\s|$)/.test(draft.trim())) {
            openModel(draft.trim().slice(6).trim());

            return;
        }

        if (kind === "prompt" && !command && attachments.files.length && /^\//.test(draft.trim())) {
            setMessage(
                "Send commands separately. Your attachments stay ready for the next message.",
            );

            return;
        }

        const controller = new AbortController();
        const who = owner();
        const current = () =>
            mounted.current && who !== null && who === owner() && store.state.privateId === id;
        const timeout = setTimeout(() => controller.abort(), 15000);

        if (kind === "prompt" && !command) {
            attachments.retain();
        } else if (pickedModel) {
            setModelCheck({
                provider: pickedModel.provider,
                modelId: pickedModel.id,
                revision: data.revision,
            });
        }

        operation.current = controller;
        setPending(kind);
        setMessage("");

        try {
            const result = await api(
                `private/${encodeURIComponent(id)}/${kind}`,
                {
                    revision: kind === "prompt" && !command ? draftRevision : data.revision,
                    ...(kind === "prompt"
                        ? {
                              text: command || draft.trim(),
                              requestId: uid(),
                              ...(!command && attachments.files.length
                                  ? {
                                        attachments: attachments.files.map((file) => file.id),
                                    }
                                  : {}),
                          }
                        : {}),
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

                if (!command) {
                    setDraft("");
                    setDraftRevision(null);
                    attachments.clear();
                } else if (/^\/model(?:\s|$)/.test(draft.trim())) {
                    setDraft("");

                    if (!attachments.files.length) {
                        setDraftRevision(null);
                    }
                }

                setModelOpen(false);
                setMessage(
                    command || /^\//.test(draft.trim())
                        ? "Command sent to Pi. Check the terminal for its result; the model follows saved history."
                        : "Sent to Pi in Herdr. Check the terminal for live output.",
                );
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
                if (kind === "prompt" && !command) {
                    attachments.retain(false);
                }

                setModelCheck(null);
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

    if (mode === "terminal") {
        return html`<${PrivateTerminal}
            id=${id}
            nativeId=${nativeId}
            instanceId=${instanceId}
            statusError=${error}
            fallback=${data?.terminal || ""}
            available=${Boolean(usable)}
        />`;
    }

    const entries = data?.entries || [];
    const results = new Map(
        entries
            .filter((entry) => entry.kind === "toolResult")
            .map((entry) => [entry.callId, entry]),
    );
    const calls = new Set(
        entries
            .flatMap((entry) => entry.blocks || [])
            .filter((block) => block.type === "toolCall")
            .map((block) => block.id),
    );
    const rows = entries.filter((entry) => entry.kind !== "toolResult" || !calls.has(entry.callId));

    return html`<main
        class="scroller private-transcript"
        aria-label="Private pane mirror"
        ref=${transcript}
        onScroll=${trackScroll(followTranscript)}
    >
        <div class="transcript">
            ${error && html`<p class="error-box" role="alert">${error} Reconnecting to Herdr…</p>`}
            ${paused && html`<p class="error-box" role="status">Snapshot paused. Updates resume when this page is visible and online.</p>`}
            ${!data && !error && !paused && html`<${Loader} label="Reading private pane" />`}
            ${
                data &&
                html`
                ${data.warnings?.map((warning) => html`<p class="error-box small">${warning}</p>`)}
                ${rows.map(
                    (entry) => html`<${TranscriptEntry}
                    key=${`${data.revision}:${entry.id}`}
                    entry=${entry}
                    results=${results}
                    readOnly=${true}
                />`,
                )}
                ${entries.length === 0 && html`<p class="muted">No saved messages. Open the terminal snapshot for live output.</p>`}
                <details class="private-terminal" onToggle=${(event) => {
                    if (event.currentTarget.open && followTerminal.current && terminal.current) {
                        terminal.current.scrollTop = terminal.current.scrollHeight;
                    }

                    if (followTranscript.current && transcript.current) {
                        transcript.current.scrollTop = transcript.current.scrollHeight;
                    }
                }}>
                    <summary>Terminal snapshot <span class="small muted">Read-only · ${new Date(data.capturedAt).toLocaleTimeString()}</span></summary>
                    <pre
                        tabindex="0"
                        ref=${terminal}
                        onScroll=${trackScroll(followTerminal)}
                    >${data.terminal || "No terminal output in this snapshot."}</pre>
                </details>
            `
            }
        </div>
    </main>
    <footer class="composer-wrap">
        <form class="private-composer" onSubmit=${(event) => {
            event.preventDefault();
            act("prompt");
        }}>
            ${data && !data.canPrompt && html`<p class="small muted">${data.reason || "This pane is read-only. Prompting is available only for a verified idle Pi."}</p>`}
            ${
                stale &&
                html`
                <p class="error-box" role="alert">The Pi session in this pane changed. Your draft has not been sent.${attachments.files.length > 0 ? " Remove these attachments and attach them again for the current session." : ""}</p>
                <button class="button small" type="button" disabled=${attachments.files.length > 0} onClick=${() => {
                    setDraftRevision(data.revision);
                    setMessage("Draft kept for the current session. Review it before sending.");
                }}>Use draft for current session</button>
            `
            }
            ${
                suggestions.length > 0 &&
                html`<div
                id="private-commands"
                class="commands"
                ref=${commandList}
                role="listbox"
                aria-label="Pi commands"
            >
                ${suggestions.map(
                    (command) => html`<button
                    type="button"
                    id=${`private-command-${command.name}`}
                    class=${`command ${command === chosen ? "on" : ""}`}
                    role="option"
                    aria-selected=${command === chosen}
                    disabled=${!canAct}
                    onMouseDown=${(event) => event.preventDefault()}
                    onClick=${() => chooseCommand(command)}
                >
                    <span class="command-name">/${command.name}</span>
                    ${command.args && html`<span class="command-args">${command.args}</span>`}
                    <span class="command-description">${command.description}</span>
                </button>`,
                )}
            </div>`
            }
            ${
                (data?.canPrompt || draft || attachments.files.length) &&
                html`<${MessageBox}
                inputRef=${prompt}
                onDragOver=${(event) => event.preventDefault()}
                onDrop=${(event) => {
                    event.preventDefault();
                    addFiles([...(event.dataTransfer?.files ?? [])]);
                }}
                before=${html`<${PrivateAttachmentChips}
                    files=${attachments.files}
                    disabled=${Boolean(pending)}
                    onRemove=${attachments.remove}
                />`}
                input=${{
                    id: "private-prompt",
                    value: draft,
                    disabled: Boolean(pending),
                    placeholder: "Message this Pi… (/ commands)",
                    "aria-label": "Message private Pi in Herdr",
                    "aria-controls": suggestions.length ? "private-commands" : undefined,
                    "aria-expanded": suggestions.length > 0,
                    "aria-activedescendant": chosen ? `private-command-${chosen.name}` : undefined,
                    enterkeyhint: matchMedia("(pointer: coarse)").matches ? "enter" : "send",
                    onInput: (event) => {
                        const text = event.currentTarget.value;

                        if ((!draft || !text) && !attachments.files.length) {
                            setDraftRevision(data?.revision ?? null);
                        }

                        setDraft(text);
                        setCommandPick(0);
                        setHideCommands(false);
                    },
                    onPaste: (event) => {
                        const files = [...(event.clipboardData?.files ?? [])];

                        if (files.length) {
                            event.preventDefault();
                            addFiles(files);
                        }
                    },
                    onKeyDown: (event) => {
                        if (event.isComposing) {
                            return;
                        }

                        if (suggestions.length) {
                            const step =
                                event.key === "ArrowDown" ? 1 : event.key === "ArrowUp" ? -1 : 0;

                            if (step) {
                                event.preventDefault();
                                setCommandPick(
                                    (commandPick + step + suggestions.length) % suggestions.length,
                                );

                                return;
                            }

                            if (event.key === "Escape") {
                                event.preventDefault();
                                setHideCommands(true);

                                return;
                            }

                            if ((event.key === "Tab" || event.key === "Enter") && !event.shiftKey) {
                                event.preventDefault();
                                chooseCommand(chosen);

                                return;
                            }
                        }

                        if (
                            event.key === "Enter" &&
                            !event.shiftKey &&
                            !event.isComposing &&
                            !matchMedia("(pointer: coarse)").matches
                        ) {
                            event.preventDefault();
                            act("prompt");
                        }
                    },
                }}
            >
                <button class="chip" type="button" onClick=${onTerminal}>
                    <${Icon} name="terminal" size=${14} /> Terminal
                </button>
                <button
                    class="icon-button"
                    type="button"
                    aria-label="Attach files"
                    disabled=${!canAct}
                    onClick=${() => filePicker.current?.click()}
                >
                    <${Icon} name="clip" />
                </button>
                <input
                    ref=${filePicker}
                    type="file"
                    multiple
                    hidden
                    disabled=${!canAct}
                    onChange=${(event) => {
                        addFiles([...(event.currentTarget.files ?? [])]);
                        event.currentTarget.value = "";
                    }}
                />
                <button
                    class="chip model-chip"
                    type="button"
                    aria-label="Change private Pi model"
                    title=${model ? `${model.provider}/${model.modelId}` : "Choose a model for this Pi"}
                    disabled=${!canAct}
                    onClick=${() => openModel()}
                >
                    <${Icon} name="sparkle" size=${14} />
                    <span>${model ? modelLabel({ model, modelName }) : "Model"}</span>
                </button>
                <span class="grow"></span>
                <${SendButton}
                    type="submit"
                    label="Send to Pi"
                    disabled=${!canSend}
                    sending=${pending === "prompt"}
                />
            </${MessageBox}>`
            }
            ${
                modelCheck &&
                !pending &&
                !uncertain &&
                html`<p class="error-box small" role="status">
                Waiting for the saved model to change. If Pi opened a selector or reported an error, finish in Terminal before sending again.
                <button
                    class="button small"
                    type="button"
                    disabled=${!usable || !data.canPrompt}
                    onClick=${() => {
                        setModelCheck(null);
                        setMessage(
                            "Continue only after checking that Pi's message editor is ready in Terminal.",
                        );
                    }}
                >I checked Pi's editor</button>
            </p>`
            }
            ${attachments.files.length > 0 && html`<p class="small muted">Files are saved privately on this server. Pi reads them by path, including images.</p>`}
            ${message && html`<p class=${`small ${uncertain ? "error-box" : "muted"}`} role="status">${message}</p>`}
        </form>
        <div class="status-line" title=${data?.pane.cwd}>Only you · Herdr · Saved history</div>
    </footer>
    ${
        modelOpen &&
        canAct &&
        html`<${PrivateModelPicker}
        models=${store.state.models}
        agent=${{ model, modelName }}
        initialQuery=${modelQuery}
        onClose=${closeModel}
        onPick=${(picked) => act("prompt", `/model ${picked.provider}/${picked.id}`, picked)}
    />`
    }`;
}
