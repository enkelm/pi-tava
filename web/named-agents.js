// Owner-only persistent PiP agents use ordinary conversations, not the floating PiP panel.
import { useEffect, useRef, useState } from "preact/hooks";
import { api, closeSheet, navigate, openSheet, store, uid } from "./store.js";
import { html, Icon, Loader, Sheet, timeAgo } from "./ui.js";
import { NamedAgentAvatar } from "./named-agent-avatar.js";

const pending = new Map();
// Keep an uncertain creation's exact body across sheet closes and tab reloads. Only an explicit retry sends it again.
const creations = new Map();
const creationKey = (userId) => `pocket.pipCreation.${userId}`;

function savedCreation(userId) {
    if (!creations.has(userId)) {
        try {
            const value = JSON.parse(sessionStorage.getItem(creationKey(userId)) ?? "null");

            if (
                typeof value?.requestId === "string" &&
                typeof value.name === "string" &&
                (value.projectId === null || typeof value.projectId === "string")
            ) {
                creations.set(userId, {
                    requestId: value.requestId,
                    name: value.name,
                    projectId: value.projectId,
                });
            }
        } catch {
            // Storage can be unavailable; the in-memory receipt still protects this open tab.
        }
    }

    return creations.get(userId) ?? null;
}

function saveCreation(userId, value) {
    if (value === null) {
        creations.delete(userId);
    } else {
        creations.set(userId, value);
    }

    try {
        if (value === null) {
            sessionStorage.removeItem(creationKey(userId));
        } else {
            sessionStorage.setItem(creationKey(userId), JSON.stringify(value));
        }
    } catch {
        // Keep the current tab's exact request if browser storage is unavailable.
    }
}

const openings = new WeakMap();
// Back from Memory or Model returns to this exact settings opening, including its unsaved charter.
const settingsDrafts = new WeakMap();

export const namedAgentsAvailable = () =>
    store.state.me?.role === "owner" && store.state.server?.privateAgents >= 3;

const styles = () => html`<style>@import url("/named-agents.css") layer(pocket);</style>`;
const creationFields = (value) => ({ name: value?.name ?? "", projectId: value?.projectId ?? "" });
const fieldsOf = (value) => ({
    name: value?.name ?? "",
    instructions: value?.instructions ?? "",
    focus: value?.focus ?? "",
});

function openSettings(id = null, agentId = null) {
    if (namedAgentsAvailable()) {
        openSheet({ type: "named-agent", id, agentId, userId: store.state.me.id, opening: uid() });
    }
}

function openAgent(id) {
    if (namedAgentsAvailable()) {
        store.set({ sidebarTab: "sessions", drawer: false });
        navigate(id);
    }
}

export function NamedAgents() {
    const [expanded, setExpanded] = useState(true);
    const [listId] = useState(() => `named-pips-${uid()}`);

    if (!namedAgentsAvailable()) {
        return null;
    }

    const agents = store.state.namedAgents ?? [];

    return html`<section class="named-agents" aria-label="PiPs">
        ${styles()}
        <div class="project-group-head named-agents-head" role="group" aria-label="PiPs controls">
            <button
                class="group-head named-agents-toggle"
                data-part="session-group-head"
                type="button"
                aria-label=${expanded ? "Collapse PiPs" : "Expand PiPs"}
                aria-expanded=${expanded}
                aria-controls=${listId}
                onClick=${() => setExpanded((value) => !value)}
            >
                <${Icon} name="pip" size=${16} />
                <span class="named-agents-label">PiPs</span>
            </button>
            <button
                class="named-agents-create"
                type="button"
                aria-label="New PiP"
                title="New PiP"
                onClick=${(event) => {
                    event.stopPropagation();
                    openSettings();
                }}
            >
                <${Icon} name="plus" size=${14} />
                ${agents.length === 0 && html`<span>New PiP</span>`}
            </button>
        </div>
        <div class="named-agents-list" id=${listId} hidden=${!expanded}>
            ${
                expanded &&
                agents.map(
                    (agent) => html`<div key=${agent.agentId}>
                    <div class="named-agent-row">
                        <button
                            class=${`named-agent-open ${(agent.chatIds ?? []).includes(store.state.conversationId) ? "on" : ""}`}
                            type="button"
                            data-part="session-button"
                            data-agent-id=${agent.agentId}
                            aria-current=${store.state.conversationId === agent.id ? "page" : undefined}
                            onClick=${() => openAgent(agent.id)}
                            title=${agent.name}
                        >
                            <${NamedAgentAvatar} agentId=${agent.agentId} />
                            <span class="named-agent-name">${agent.name}</span>
                            <span class="named-agent-status small muted">
                                ${agent.busy ? "Working" : agent.updatedAt ? timeAgo(agent.updatedAt) : "Ready"}
                            </span>
                        </button>
                        <button
                            class="icon-button"
                            type="button"
                            aria-label=${`Edit ${agent.name}`}
                            title=${`Edit ${agent.name}`}
                            onClick=${() => openSettings(agent.id, agent.agentId)}
                        >
                            <${Icon} name="pencil" size=${16} />
                        </button>
                    </div>
                    </div>`,
                )
            }
        </div>
    </section>`;
}

function History({ data, disabled, restore }) {
    const previous = (data.history ?? []).filter((entry) => entry.revision !== data.revision);

    return html`<details class="named-agent-history">
        <summary>History & undo (${previous.length})</summary>
        <p class="muted small">The latest 20 revisions are retained. Restoring one saves a new revision.</p>
        ${previous.length === 0 && html`<p class="muted small">No earlier revisions.</p>`}
        ${previous.map(
            (entry) => html`<details key=${entry.revision}>
                <summary>${`Revision ${entry.revision} · ${entry.name || "Unnamed agent"}`}</summary>
                <p class="muted small">
                    ${[entry.at ? new Date(entry.at).toLocaleString() : "", entry.by, entry.source].filter(Boolean).join(" · ")}
                </p>
                <dl>
                    ${[
                        ["Name", entry.name],
                        ["Instructions", entry.instructions],
                        ["Focus", entry.focus],
                    ].map(([label, value]) => html`<dt>${label}</dt><dd>${value || "None"}</dd>`)}
                </dl>
                <button
                    class="button"
                    type="button"
                    disabled=${disabled}
                    onClick=${() => restore(entry.revision)}
                >
                    ${`Restore revision ${entry.revision}`}
                </button>
            </details>`,
        )}
    </details>`;
}

function ControllerAccess({ data, disabled, refresh, close }) {
    const controllers = data.controllers ?? [];

    return html`<section class="named-agent-section" aria-label="Contacted Work Items">
        <h3>Work Items</h3>
        <p class="small muted">Contacted Work Items appear automatically. Links open their exact orchestrators without activating supervision.</p>
        ${controllers.length === 0 && html`<p class="small muted">No contacted Work Items.</p>`}
        <ul class="named-agent-controllers">
            ${controllers.map(
                (controller) => html`
                <li key=${controller.workItemId}>
                    <a
                        class="named-agent-controller-link"
                        aria-label=${`Open orchestrator for ${controller.title}`}
                        href=${`/s/${controller.conversationId}`}
                        onClick=${(event) => {
                            if (!namedAgentsAvailable()) {
                                event.preventDefault();

                                return;
                            }

                            if (event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) {
                                return;
                            }

                            event.preventDefault();
                            close();
                            openAgent(controller.conversationId);
                        }}
                    >
                        <span>${controller.title}</span>
                        <span class="small muted">${controller.state}</span>
                    </a>
                    ${controller.reason && html`<p class="small muted">${controller.reason}</p>`}
                </li>
            `,
            )}
        </ul>
        <div class="named-agent-actions">
            <button class="button" type="button" disabled=${disabled} onClick=${refresh}>
                Refresh Work Items
            </button>
        </div>
        <p class="small muted">Status is from the last refresh. Native controls remain in each Work Item's orchestrator.</p>
    </section>`;
}

function AgentForm({ sheet, id, userId, close }) {
    const key = `${userId}:${sheet.agentId ?? id ?? "new"}`;
    const editing = id !== null;
    const [creation, setCreation] = useState(() => (editing ? null : savedCreation(userId)));
    const [draft, setDraft] = useState(() =>
        editing
            ? (settingsDrafts.get(sheet)?.fields ?? fieldsOf())
            : creationFields(savedCreation(userId)),
    );
    const [data, setData] = useState(null);
    const [loading, setLoading] = useState(true);
    const [busy, setBusy] = useState(false);
    const [error, setError] = useState("");
    const [status, setStatus] = useState("");
    const [blocked, setBlocked] = useState(false);
    const [reload, setReload] = useState(0);
    const replaceDraft = useRef(true);
    const mounted = useRef(false);
    const sending = useRef(false);
    const viewId = useRef(store.state.conversationId);
    const path = editing ? `c/${encodeURIComponent(id)}/private-agent` : "pip/agents";
    const live = () =>
        mounted.current &&
        namedAgentsAvailable() &&
        store.state.me.id === userId &&
        store.state.sheet === sheet &&
        store.state.conversationId === viewId.current;

    useEffect(() => {
        mounted.current = true;
        let cancelled = false;
        const stop = new AbortController();

        setLoading(true);

        const load = async () => {
            const waiting = pending.get(key);
            const accepted = await waiting?.flight.catch(() => null);

            if (cancelled || !live()) {
                return;
            }

            if (!editing && accepted?.id !== undefined) {
                close();
                openAgent(accepted.id);

                return;
            }

            try {
                const result = await api(editing ? path : "projects", undefined, {
                    signal: stop.signal,
                });

                if (cancelled || !live()) {
                    return;
                }

                if (editing && result.id !== id) {
                    throw new Error(
                        "The server returned a different agent. Close and reopen settings.",
                    );
                }

                const cached = editing ? settingsDrafts.get(sheet) : null;
                const changed = cached && cached.revision !== result.revision;

                setData(result);
                setDraft((previous) =>
                    editing && replaceDraft.current && !cached ? fieldsOf(result) : previous,
                );
                replaceDraft.current = true;
                setCreation(creations.get(userId) ?? null);
                setBlocked(!!changed);
                setError(
                    changed
                        ? "These settings changed elsewhere. Your draft is kept below. Load the latest settings before making another change."
                        : "",
                );
            } catch (failure) {
                if (!cancelled && live()) {
                    setError(failure.message ?? String(failure));
                }
            } finally {
                if (!cancelled && live()) {
                    setLoading(false);
                }
            }
        };

        load();

        return () => {
            cancelled = true;
            mounted.current = false;
            stop.abort();
        };
    }, [id, userId, sheet, reload]);

    const submit = async (revision = null) => {
        if (!live() || loading || sending.current || pending.has(key) || blocked || !data) {
            return;
        }

        const body = editing
            ? revision === null
                ? { ...draft, name: draft.name.trim(), expectedRevision: data.revision }
                : { action: "undo", expectedRevision: data.revision, revision }
            : (creations.get(userId) ?? {
                  name: draft.name.trim(),
                  projectId: draft.projectId || null,
                  requestId: uid(),
              });

        if (!editing) {
            saveCreation(userId, body);
            setCreation(body);
        }

        sending.current = true;
        setBusy(true);
        setError("");
        setStatus("");
        const flight = api(path, body);

        const request = { flight };

        pending.set(key, request);

        try {
            const result = await flight;

            if (!editing) {
                saveCreation(userId, null);
            } else {
                settingsDrafts.delete(sheet);
            }

            if (!live()) {
                return;
            }

            if (!editing) {
                close();
                openAgent(result.id);
            } else {
                setBlocked(true);
                replaceDraft.current = true;
                setStatus(revision === null ? "Settings saved." : `Restored revision ${revision}.`);
                setReload((value) => value + 1);
            }
        } catch (failure) {
            // A definite validation/auth rejection can be edited. An uncertain creation must keep its exact identity.
            if (
                !editing &&
                failure.status >= 400 &&
                failure.status < 500 &&
                failure.status !== 408 &&
                failure.status !== 409
            ) {
                saveCreation(userId, null);
            }

            if (live()) {
                // Field validation rejects before writing; correcting the draft needs no fresh revision.
                const invalid = failure.status === 400;

                setCreation(creations.get(userId) ?? null);
                setBlocked(editing && !invalid);
                setError(
                    editing
                        ? invalid
                            ? failure.message
                            : failure.status === 409
                              ? "These settings changed elsewhere. Your draft is kept below. Load the latest settings before making another change."
                              : `${failure.message} The change may have reached the server. Load the latest settings before retrying.`
                        : creations.has(userId)
                          ? `${failure.message} Creation may have succeeded. Retry uses the same request without creating a second agent.`
                          : failure.message,
                );
            }
        } finally {
            if (pending.get(key) === request) {
                pending.delete(key);
            }

            sending.current = false;

            if (live()) {
                setBusy(false);
            }
        }
    };

    const locked = loading || busy || (!editing && creation !== null);
    const memoryEnabled = store.state.server?.extensions?.includes("pocket-memory") === true;

    const change = (field) => (event) => {
        const value = event.currentTarget.value;

        setDraft((previous) => {
            const fields = { ...previous, [field]: value };

            if (editing) {
                settingsDrafts.set(sheet, {
                    fields,
                    revision: settingsDrafts.get(sheet)?.revision ?? data.revision,
                });
            }

            return fields;
        });
        setStatus("");
    };

    return html`<form
        class="named-agent-form"
        onSubmit=${(event) => {
            event.preventDefault();

            if (draft.name.trim()) {
                submit();
            }
        }}
    >
        <p class="muted small">
            ${
                editing
                    ? "Private to you. This identity and its approved instructions are shared across its chats."
                    : "Private to you. Your PiP will help you work out its purpose in the conversation."
            }
        </p>
        ${loading && html`<${Loader} label=${editing ? "Loading PiP settings" : "Loading projects"} />`}
        ${error && html`<p class="error-box" role="alert">${error}</p>`}
        ${status && html`<p role="status">${status}</p>`}
        ${
            data &&
            html`
                ${
                    editing &&
                    html`
                    <div class="named-agent-actions">
                        <button
                            class="button"
                            type="button"
                            disabled=${!memoryEnabled}
                            onClick=${() => {
                                if (live() && memoryEnabled) {
                                    openSheet({ type: "memory", conversationId: id });
                                }
                            }}
                        >Memory</button>
                        <button
                            class="button"
                            type="button"
                            onClick=${() => {
                                if (!live()) {
                                    return;
                                }

                                if (store.state.view?.conversation?.pipAgentId === data.agentId) {
                                    openSheet({ type: "model" });
                                } else {
                                    close();
                                    openAgent(id);
                                }
                            }}
                        >${store.state.view?.conversation?.pipAgentId === data.agentId ? "Model" : "Open chat for model"}</button>
                    </div>
                    ${!memoryEnabled && html`<p class="small muted">Memory extension is off. Enable it in Extensions to manage lessons.</p>`}
                    <details class="named-agent-chats" aria-label=${`Chats with ${data.name}`}>
                        <summary>Chats (${(data.chats ?? data.chatIds ?? []).length})</summary>
                        <p class="small muted">Closing a tab keeps its chat and running work. Open any retained chat here.</p>
                        <ul>
                            ${(
                                data.chats ?? (data.chatIds ?? []).map((chatId) => ({ id: chatId }))
                            ).map(
                                (chat) => html`<li key=${chat.id}>
                                    <a
                                        href=${`/s/${chat.id}`}
                                        onClick=${(event) => {
                                            if (!live()) {
                                                event.preventDefault();

                                                return;
                                            }

                                            if (
                                                event.metaKey ||
                                                event.ctrlKey ||
                                                event.shiftKey ||
                                                event.altKey
                                            ) {
                                                return;
                                            }

                                            event.preventDefault();
                                            close();
                                            openAgent(chat.id);
                                        }}
                                    >
                                        <span>${chat.title || `Chat ${chat.id}`}</span>
                                        ${chat.busy && html`<span class="small muted">Working</span>`}
                                    </a>
                                </li>`,
                            )}
                        </ul>
                    </details>
                `
                }
                ${
                    editing &&
                    html`
                    <${ControllerAccess}
                        data=${data}
                        disabled=${loading || busy || blocked}
                        close=${close}
                        refresh=${() => {
                            if (!live() || locked) {
                                return;
                            }

                            replaceDraft.current = false;
                            setReload((value) => value + 1);
                        }}
                    />
                `
                }
                <label class="field">
                    <span class="label">Name</span>
                    <input
                        aria-label="Agent name"
                        value=${draft.name}
                        disabled=${locked}
                        required
                        maxLength="80"
                        onInput=${change("name")}
                    />
                </label>
                ${
                    !editing &&
                    html`
                        <label class="field">
                            <span class="label">Project (optional)</span>
                            <select
                                aria-label="PiP project"
                                value=${draft.projectId}
                                disabled=${locked}
                                onChange=${change("projectId")}
                            >
                                <option value="">No project</option>
                                ${
                                    draft.projectId &&
                                    !(data.projects ?? []).some(
                                        (project) => project.id === draft.projectId,
                                    ) &&
                                    html`<option value=${draft.projectId} disabled>Unavailable project</option>`
                                }
                                ${(data.projects ?? []).map(
                                    (project) => html`
                                    <option key=${project.id} value=${project.id}>${project.name}</option>
                                `,
                                )}
                            </select>
                            <span class="muted small">A remit only. Does not change access or working directory.</span>
                        </label>
                `
                }
                ${
                    editing &&
                    html`
                        <p class="muted small">
                            Project remit: ${
                                data.project
                                    ? data.project.available
                                        ? data.project.name
                                        : "Unavailable project"
                                    : "No project"
                            }
                        </p>
                        <label class="field">
                            <span class="label">Instructions</span>
                            <textarea
                                aria-label="Agent instructions"
                                title="Agent-requested revisions are proposals for your approval. Instructions change only when you save settings."
                                rows="7"
                                value=${draft.instructions}
                                disabled=${locked}
                                onInput=${change("instructions")}
                            ></textarea>
                        </label>
                        ${
                            editing &&
                            data.proposal &&
                            html`<details class="named-agent-proposal">
                                <summary>Review proposed instructions</summary>
                                <div class="named-agent-proposal-body">
                                    <p class="small"><strong>Agent proposal — not active</strong></p>
                                    <p class="muted small">Using this proposal only fills your draft. Review it and choose Save settings to approve.</p>
                                    <p class="muted small">
                                        ${`Proposed for revision ${data.proposal.expectedRevision}${data.proposal.at ? ` · ${new Date(data.proposal.at).toLocaleString()}` : ""}`}
                                    </p>
                                    <label class="field">
                                        <span class="label">Proposed instructions</span>
                                        <textarea
                                            aria-label="Proposed instructions"
                                            rows="6"
                                            readOnly=${true}
                                            value=${data.proposal.instructions}
                                        ></textarea>
                                    </label>
                                    <button
                                        class="button"
                                        type="button"
                                        disabled=${locked || blocked}
                                        onClick=${() => {
                                            if (!live() || locked || blocked) {
                                                return;
                                            }

                                            setDraft((previous) => {
                                                const fields = {
                                                    ...previous,
                                                    instructions: data.proposal.instructions,
                                                };

                                                settingsDrafts.set(sheet, {
                                                    fields,
                                                    revision:
                                                        settingsDrafts.get(sheet)?.revision ??
                                                        data.revision,
                                                });

                                                return fields;
                                            });
                                            setStatus(
                                                "Proposal copied into your draft. Review it, then save settings to approve.",
                                            );
                                        }}
                                    >
                                        Use proposal
                                    </button>
                                </div>
                            </details>`
                        }

                        <label class="field">
                            <span class="label">Focus (optional)</span>
                            <textarea
                                aria-label="Agent focus"
                                rows="2"
                                value=${draft.focus}
                                disabled=${locked}
                                onInput=${change("focus")}
                            ></textarea>
                            <span class="muted small">A freeform remit, not authority. Focus grants no tools or permissions.</span>
                        </label>
                        <p class="muted small">${`Revision ${data.revision}`}</p>
                    `
                }
                <div class="named-agent-actions">
                    <button
                        class="button primary"
                        type="submit"
                        disabled=${loading || busy || blocked || !draft.name.trim()}
                    >
                        ${busy ? (editing ? "Working…" : "Creating…") : editing ? "Save settings" : creation ? "Retry creation" : "Create PiP"}
                    </button>
                    <button class="button" type="button" onClick=${close}>Close</button>
                </div>
                ${editing && html`<${History} data=${data} disabled=${loading || busy || blocked} restore=${submit} />`}
            `
        }
        ${
            error &&
            html`<button
                class="button"
                type="button"
                disabled=${loading || busy}
                onClick=${() => {
                    setStatus("");
                    replaceDraft.current = true;
                    settingsDrafts.delete(sheet);
                    setReload((value) => value + 1);
                }}
            >
                ${editing && data ? "Load latest settings (replaces draft)" : "Retry loading"}
            </button>`
        }
    </form>`;
}

export function NamedAgentSheet({ sheet, id = sheet.id ?? null }) {
    const userId = sheet.userId ?? store.state.me?.id;

    if (!namedAgentsAvailable() || userId !== store.state.me.id) {
        return null;
    }

    if (!openings.has(sheet)) {
        openings.set(sheet, uid());
    }

    const close = () => {
        if (store.state.sheet === sheet) {
            closeSheet();
        }
    };

    return html`<${Sheet} title=${id === null ? "New PiP" : "PiP settings"} onClose=${close}>
        ${styles()}
        <${AgentForm} key=${`${userId}:${id}:${openings.get(sheet)}`} sheet=${sheet} id=${id} userId=${userId} close=${close} />
    <//>`;
}
