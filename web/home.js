// Home creates through the native draft and session paths; it never owns a second chat model.
import { useCallback, useEffect, useId, useRef, useState } from "preact/hooks";
import { useBack } from "./back.js";
import { openAgentDraft } from "./agent-drafts.js";
import { NamedAgentAvatar } from "./named-agent-avatar.js";
import { namedAgentsAvailable, openAgentSettings } from "./named-agents.js";
import { ProjectFilters, projectsMatchingFilter } from "./project-access.js";
import { ProjectForm } from "./sheets/project.js";
import { ImportPanel, piSessionsAvailable } from "./sheets/pi-sessions.js";
import { ProjectSessionPanel } from "./sheets/session-projects.js";
import { RemoteProjectIcon } from "./ssh-status.js";
import {
    actions,
    canSteer,
    closeSheet,
    navigate,
    openSheet,
    scoped,
    store,
    workspaceOrder,
} from "./store.js";
import { html, Icon, Loader, Sheet } from "./ui.js";
import { LocationPicker, recentSshFolders, rememberSshFolder } from "./workspace-location.js";
import { rowOpenId } from "./work-items.js";
import { projectAgentContext } from "./project-groups.js";

// Navigation needs room for a 260px list and a usable stacked setup pane, including iPad portrait.
// Touch and OS identity do not decide whether that room is available.
function useRoomyLayout() {
    const [roomy, setRoomy] = useState(() => matchMedia("(min-width: 768px)").matches);

    useEffect(() => {
        const media = matchMedia("(min-width: 768px)");
        const resize = () => setRoomy(media.matches);

        media.addEventListener("change", resize);

        return () => media.removeEventListener("change", resize);
    }, []);

    return roomy;
}

/** The same native flow is a desktop/tablet page or retained modal, never two form models. */
function CreationSurface({
    intent,
    active,
    inline = false,
    compact = false,
    page = false,
    generation = 0,
    onInteract,
    onClose,
    isCurrentOpening,
    isActive,
}) {
    const viewport = useRef(null);

    useEffect(() => {
        if (!active || inline || !globalThis.visualViewport) {
            return undefined;
        }

        const view = globalThis.visualViewport;
        const style = viewport.current.style;

        const size = () => {
            style.setProperty("--creation-viewport-height", `${view.height}px`);
            style.setProperty("--creation-viewport-top", `${view.offsetTop}px`);
            style.setProperty(
                "--creation-viewport-bottom",
                `${Math.max(0, innerHeight - view.height - view.offsetTop)}px`,
            );
        };

        size();
        view.addEventListener("resize", size);
        view.addEventListener("scroll", size);

        return () => {
            view.removeEventListener("resize", size);
            view.removeEventListener("scroll", size);
        };
    }, [active, inline]);

    return html`<div
        class=${`home-creation-viewport ${page ? "home-creation-page" : ""}`}
        ref=${viewport}
        hidden=${!active && !inline}
        inert=${!active && !inline}
        onClick=${active ? onInteract : undefined}
        onInput=${active ? onInteract : undefined}
        onChange=${active ? onInteract : undefined}
    >
        <${Sheet}
            title="New Session"
            class="home-creation-sheet"
            bottom=${compact && !inline}
            wide=${!compact && !inline}
            inline=${inline}
            active=${active}
            onClose=${onClose}
        >
            <${HomeCreation}
                key=${generation}
                intent=${intent}
                embedded=${!inline}
                compact=${compact}
                active=${active}
                onCancel=${inline ? onClose : undefined}
                isCurrentOpening=${isCurrentOpening}
                isActive=${isActive}
            />
        <//>
    </div>`;
}

export function HomeCreationSheet({ sheet, active = true }) {
    const roomy = useRoomyLayout();

    return html`<${CreationSurface}
        intent=${sheet}
        active=${active}
        compact=${!roomy}
        onClose=${closeSheet}
        isCurrentOpening=${() =>
            store.state.sheet === sheet || store.state.sheet?.creationParent === sheet}
        isActive=${() => store.state.sheet === sheet}
    />`;
}

/** Resizing an unfinished desktop page into a phone keeps the same mounted form in a sheet. */
export function HomeCreationPage() {
    const roomy = useRoomyLayout();
    const [generation, reset] = useState(0);
    const lifetime = useRef(0);
    const intent = store.state.homeCreation;
    const sourceId = intent?.id ?? "home";
    const active = !store.state.sheet && (roomy || !!intent);

    const close = () => {
        const destination = intent?.returnTo;

        // Invalidate callbacks synchronously, including a default page that resets at the same URL.
        lifetime.current++;
        reset(lifetime.current);
        navigate(destination?.conversationId ?? null, destination ?? { replace: true });
    };

    const engage = (event) => {
        const state = store.state;

        if (
            event.target.closest?.(".home-creation") &&
            !state.homeCreation &&
            state.conversationId === null &&
            state.projectId == null &&
            !state.agentDraft &&
            state.privateId === null
        ) {
            // Keep the default page's existing App key, so an ordinary project/form interaction
            // makes its setup resumable on narrowing without remounting any native fields.
            store.set({ homeCreation: { id: "home" } });
        }
    };

    useBack(!roomy && !!intent && active, close);
    useEffect(() => {
        if (!roomy || !intent || !active) {
            return undefined;
        }

        const onKey = (event) => {
            const state = store.state;

            if (
                event.key === "Escape" &&
                !event.defaultPrevented &&
                !event.isComposing &&
                event.keyCode !== 229 &&
                !state.sheet &&
                !state.launcher &&
                !state.drawer
            ) {
                event.preventDefault();
                close();
            }
        };

        addEventListener("keydown", onKey);

        return () => removeEventListener("keydown", onKey);
    }, [roomy, intent, active]);

    return html`<${CreationSurface}
        intent=${intent}
        active=${active}
        inline=${roomy}
        compact=${!roomy}
        page=${true}
        generation=${generation}
        onInteract=${engage}
        onClose=${close}
        isCurrentOpening=${() => {
            const state = store.state;

            return (
                lifetime.current === generation &&
                (state.homeCreation?.id ?? "home") === sourceId &&
                state.conversationId === null &&
                state.projectId === null &&
                state.privateId === null &&
                !state.agentDraft
            );
        }}
        isActive=${() => !store.state.sheet}
    />`;
}

export function HomeCreation({
    intent = store.state.homeCreation,
    embedded = false,
    compact = false,
    active = true,
    onCancel,
    isCurrentOpening,
    isActive,
} = {}) {
    const { projects = [], projectsLoaded, namedAgents: catalogue = [], me, server } = store.state;
    const homeCreation = intent;
    const owner = me?.role === "owner";
    const canStart = canSteer() && !scoped();
    const named = namedAgentsAvailable();
    const namedAgents = named ? catalogue : [];
    const [filter, setFilter] = useState("all");
    const [projectId, setProjectId] = useState(homeCreation?.projectId ?? null);
    const [choices, setChoices] = useState({});
    const nativeWorkIntent = !!(homeCreation?.continuation || homeCreation?.cwd);
    const [mode, setMode] = useState(nativeWorkIntent ? "work" : "chat");
    const [otherOpen, setOtherOpen] = useState(nativeWorkIntent);
    const [importVisited, setImportVisited] = useState(false);
    const alternativesId = useId();
    const [creating, setCreating] = useState(false);
    const [addingMachine, setAddingMachine] = useState(false);
    const [machine, setMachine] = useState({ kind: "ssh", host: "" });
    const [busy, updateBusy] = useState(false);
    const pending = useRef(false);
    const setBusy = useCallback((working) => {
        pending.current = working;
        updateBusy(working);
    }, []);
    const [error, setError] = useState("");
    const root = useRef(null);
    const opening = useRef(false);
    const project = projects.find((item) => item.id === projectId);
    const relatedAgents = project ? projectAgentContext(project, namedAgents).relatedAgents : [];
    const agentId = choices[projectId] ?? project?.defaultAgentId ?? "";
    const agent = namedAgents.find((item) => item.agentId === agentId);
    const listed = projectsMatchingFilter(projects, filter);
    const recent = workspaceOrder().slice(0, 5);
    const hosts = owner ? recentSshFolders().map((item) => item.host) : [];
    const returnTo = homeCreation?.returnTo;
    const canCancel =
        returnTo &&
        (returnTo.conversationId != null ||
            returnTo.projectId != null ||
            returnTo.agentDraft ||
            returnTo.privateId);
    const importAllowed = piSessionsAvailable();
    const showWork = otherOpen && mode === "work";
    const host = useRef(null);

    host.current = { active, otherOpen, mode, creating, isCurrentOpening, isActive };
    const importOpening = useCallback(() => host.current.isCurrentOpening?.() ?? true, []);
    const importActive = useCallback(() => {
        const current = host.current;
        const state = store.state;

        return (
            current.active &&
            current.otherOpen &&
            current.mode === "import" &&
            !current.creating &&
            !state.launcher &&
            !state.drawer &&
            !state.board &&
            !state.page &&
            (current.isActive?.() ?? true)
        );
    }, []);

    const chooseWay = (next) => {
        if (!active || pending.current) {
            return;
        }

        setMode(next);

        if (next === "import") {
            setImportVisited(true);
        }
    };

    const reload = () => {
        setError("");
        actions.loadProjects().catch((failure) => setError(failure.message));
    };

    useEffect(() => {
        if (!store.state.projectsLoaded) {
            reload();
        }
    }, []);

    // Retain Home's visible recent-session digit shortcuts, without stealing typing or modal input.
    useEffect(() => {
        const onKey = (event) => {
            const index = Number(event.key) - 1;

            if (
                !active ||
                embedded ||
                event.defaultPrevented ||
                event.altKey ||
                event.ctrlKey ||
                event.metaKey ||
                !(index >= 0 && index < 5) ||
                event.target?.closest?.("input, textarea, select, [contenteditable]") ||
                store.state.sheet ||
                store.state.launcher ||
                !(root.current?.checkVisibility?.() ?? root.current?.getClientRects().length > 0)
            ) {
                return;
            }

            const session = workspaceOrder()[index];

            if (session) {
                event.preventDefault();
                navigate(rowOpenId(session));
            }
        };

        addEventListener("keydown", onKey);

        return () => removeEventListener("keydown", onKey);
    }, [active, embedded]);

    useBack(active && creating, () => setCreating(false));
    useBack(active && addingMachine, () => setAddingMachine(false));
    useBack(active && !creating && !addingMachine && otherOpen, () => {
        if (!pending.current) {
            setOtherOpen(false);
        }
    });
    useBack(active && !creating && !addingMachine && otherOpen && mode !== "chat", () => {
        if (!pending.current) {
            setMode("chat");
        }
    });

    const chooseProject = (id) => {
        if (!active || pending.current) {
            return;
        }

        setProjectId(id);

        // Import and standalone Chat own their destinations; Home must never retarget them.
        if (mode !== "import" && mode !== "one-time" && (nativeWorkIntent || !named)) {
            setMode("work");
            setOtherOpen(true);
        }

        setError("");
    };

    const changeFilter = (next) => {
        if (!active || pending.current) {
            return;
        }

        setFilter(next);

        if (!projectsMatchingFilter(projects, next).some((item) => item.id === projectId)) {
            setProjectId(null);

            if (mode === "work") {
                setMode("chat");
            }
        }
    };

    const createAgent = (onCreated) => openAgentSettings(null, null, null, { onCreated });

    const startChat = () => {
        if (
            !active ||
            !canSteer() ||
            scoped() ||
            !namedAgentsAvailable() ||
            !project ||
            !agent ||
            opening.current ||
            pending.current
        ) {
            return;
        }

        opening.current = true;
        const draft = openAgentDraft(agent.agentId, { projectId: project.id });

        if (!draft) {
            opening.current = false;
        }
    };

    const saveMachine = (event) => {
        event.preventDefault();

        if (!owner || machine?.kind !== "ssh" || !machine.host.trim()) {
            return;
        }

        // Reuse the current person's remembered destinations. Saving never logs in or probes a host.
        rememberSshFolder(machine, "~");
        changeFilter(`ssh:${machine.host.trim()}`);
        setAddingMachine(false);
    };

    return html`<main
        key="content"
        class=${`home-creation ${embedded ? "home-creation-embedded" : ""} ${compact ? "home-creation-compact" : ""}`}
        data-part="home"
        ref=${root}
    >
        <div class="home-creation-content">
            ${
                !embedded &&
                canCancel &&
                html`<button
                    class="icon-button home-creation-close"
                    type="button"
                    aria-label="Cancel New Session"
                    disabled=${!active || busy}
                    onClick=${(event) => {
                        event.stopPropagation();

                        if (!active || pending.current) {
                            return;
                        }

                        if (onCancel) {
                            onCancel();
                        } else {
                            navigate(returnTo.conversationId, returnTo);
                        }
                    }}
                ><${Icon} name="close" /></button>`
            }
            <h1
                class=${canCancel ? "home-cancellable-title" : ""}
                hidden=${embedded}
            >New Session</h1>
            <p class="muted">Choose a project to chat with its named agent, or explore other ways to start.</p>
            ${
                creating
                    ? html`<section aria-label="New Project">
                        <h2>New Project</h2>
                        <${ProjectForm}
                            key=${filter}
                            initialLocation=${
                                filter.startsWith("ssh:")
                                    ? { kind: "ssh", host: filter.slice(4) }
                                    : null
                            }
                            onCreateAgent=${createAgent}
                            visible=${active}
                            onBusyChange=${setBusy}
                            onCancel=${() => setCreating(false)}
                            onSaved=${(id) => {
                                chooseProject(id);
                                setCreating(false);
                            }}
                        />
                    </section>`
                    : html`
                        <div class="home-project-toolbar">
                            <${ProjectFilters}
                                projects=${projects}
                                hosts=${hosts}
                                filter=${filter}
                                onChange=${changeFilter}
                                disabled=${busy}
                            />
                            ${
                                owner &&
                                server?.sshWorkspaces >= 1 &&
                                html`<button
                                class="button small"
                                disabled=${busy}
                                onClick=${() => setAddingMachine(true)}
                            ><${Icon} name="monitor" size=${16} /> Add Machine</button>`
                            }
                        </div>
                        ${
                            addingMachine &&
                            html`<form class="home-machine-form" onSubmit=${saveMachine}>
                            <h2>Add Machine</h2>
                            <p class="small muted">Remember an SSH destination in this browser. No connection is started.</p>
                            <${LocationPicker}
                                location=${machine}
                                onChange=${setMachine}
                                showLogin=${false}
                            />
                            <div class="row">
                                <button
                                    class="button primary"
                                    type="submit"
                                    disabled=${machine?.kind !== "ssh" || !machine.host.trim()}
                                >
                                    Add Machine
                                </button>
                                <button
                                    class="button"
                                    type="button"
                                    onClick=${() => setAddingMachine(false)}
                                >
                                    Cancel
                                </button>
                            </div>
                        </form>`
                        }
                        ${!projectsLoaded && !error && html`<${Loader} label="Loading projects" />`}
                        <div class="home-launch-layout">
                            <div class="home-project-list">
                                <div
                                    class="home-project-choices"
                                    role="group"
                                    aria-label="Choose a project"
                                >
                                    ${listed.map((item) => {
                                        const assigned = namedAgents.find(
                                            (identity) => identity.agentId === item.defaultAgentId,
                                        );

                                        return html`<button
                                            key=${item.id}
                                            class=${`list-item home-project-choice ${item.id === projectId ? "active" : ""}`}
                                            aria-pressed=${item.id === projectId}
                                            disabled=${busy}
                                            onClick=${() => chooseProject(item.id)}
                                        >
                                            ${
                                                assigned
                                                    ? html`<${NamedAgentAvatar} agentId=${assigned.agentId} size=${26} />
                                                    <span class="home-project-agent">${assigned.name}</span>
                                                    <span class="muted" aria-hidden="true">·</span>`
                                                    : html`<${Icon} name="folder" size=${18} />`
                                            }
                                            <span class="home-project-name">${item.name}</span>
                                            ${item.location?.kind === "ssh" && html`<${RemoteProjectIcon} location=${item.location} />`}
                                            ${item.id === projectId && html`<${Icon} name="check" size=${16} />`}
                                        </button>`;
                                    })}
                                </div>
                                ${projectsLoaded && listed.length === 0 && html`<p class="muted small">${projects.length === 0 && !owner ? "No project access yet. Ask the owner to grant a project." : "No projects on this machine yet."}</p>`}
                                ${
                                    owner &&
                                    html`<button
                                        class="button small"
                                        disabled=${busy}
                                        onClick=${() => setCreating(true)}
                                    >
                                        <${Icon} name="plus" size=${16} /> New Project
                                    </button>`
                                }
                            </div>
                            <section class="home-detail" aria-label="Selected project actions">
                                ${!project && html`<div class="home-choose-project"><h2>Choose a project</h2><p class="muted">Its agent and Work Item options will appear here.</p></div>`}
                                ${projectId && !project && projectsLoaded && html`<p class="error" role="status">This project is no longer available. Choose another project.</p>`}
                                ${
                                    project &&
                                    html`<section class="home-session-choice" aria-label="Session setup">
                                        <div class="home-agent-heading">
                                            ${named && (agent ? html`<${NamedAgentAvatar} agentId=${agent.agentId} size=${44} />` : html`<${Icon} name="chat" size=${32} />`)}
                                            <div>
                                                <h2>${named ? (agent ? `Talk to ${agent.name}` : "Choose an agent") : project.name}</h2>
                                                ${named && html`<p class="muted small">${project.name} · ${project.location?.kind === "ssh" ? project.location.host : "Local"}</p>`}
                                            </div>
                                        </div>
                                    ${
                                        named &&
                                        html`<label>
                                        <span class="label">Named agent</span>
                                        <select
                                            aria-label="Named agent"
                                            value=${agentId}
                                            disabled=${busy}
                                            onChange=${(event) => {
                                                const value = event.currentTarget.value;
                                                const choose = (id) =>
                                                    setChoices((previous) => ({
                                                        ...previous,
                                                        [project.id]: id,
                                                    }));

                                                if (value === "__create") {
                                                    createAgent((identity) =>
                                                        choose(identity.agentId),
                                                    );
                                                } else {
                                                    choose(value);
                                                }
                                            }}
                                        >
                                            <option value="">Choose a named agent…</option>
                                            ${agentId && !agent && html`<option value=${agentId} disabled>Unavailable agent</option>`}
                                            ${namedAgents.map((identity) => html`<option key=${identity.agentId} value=${identity.agentId}>${identity.name}${identity.agentId === project.defaultAgentId ? " · Default" : identity.projectId === project.id ? " · Related to this project" : ""}</option>`)}
                                            <option value="__create">Create named agent…</option>
                                        </select>
                                    </label>`
                                    }
                                    ${named && !project.defaultAgentId && relatedAgents.length > 0 && html`<p class="small muted">No default agent selected. Related PiPs: ${relatedAgents.map((identity) => identity.name).join(", ")}. Choose an agent for this Chat; this does not set a project default.</p>`}
                                    ${
                                        named &&
                                        html`
                                        <p class="small muted">The project supplies context and defaults, not an access boundary. Memory and instructions are shared across this agent's chats.</p>
                                        <button
                                            class="button primary wide"
                                            disabled=${busy || !canStart || !agent}
                                            onClick=${startChat}
                                        >
                                            ${agent ? html`<${NamedAgentAvatar} agentId=${agent.agentId} size=${24} />` : html`<${Icon} name="chat" size=${18} />`}
                                            Chat with ${agent?.name ?? "a named agent"}
                                        </button>
                                    `
                                    }
                                </section>`
                                }
                            </section>
                        </div>
                    `
            }
            ${
                (canStart || importAllowed) &&
                html`<section
                    key="other-ways"
                    class="home-other-ways"
                    hidden=${creating}
                    aria-label="Other ways to start"
                >
                    <button
                        class="button home-other-disclosure"
                        type="button"
                        aria-expanded=${otherOpen}
                        aria-controls=${alternativesId}
                        disabled=${busy || !active}
                        onClick=${() => {
                            if (active && !pending.current) {
                                setOtherOpen((value) => !value);
                            }
                        }}
                    ><${Icon} name="down" class="home-disclosure-chevron" size=${16} /> Other ways to start</button>
                    <div id=${alternativesId} class="home-other-options" hidden=${!otherOpen}>
                        <div class="home-other-actions" role="group" aria-label="Start another way">
                            ${
                                canStart &&
                                html`<button
                                    class="button"
                                    type="button"
                                    aria-pressed=${mode === "work"}
                                    aria-controls=${`${alternativesId}-work`}
                                    aria-describedby=${!project ? `${alternativesId}-project-hint` : undefined}
                                    disabled=${busy || !active || !project}
                                    onClick=${() => chooseWay("work")}
                                ><${Icon} name="bot" size=${18} /> New Work Item</button>`
                            }
                            ${
                                importAllowed &&
                                html`<button
                                    class="button"
                                    type="button"
                                    aria-pressed=${mode === "import"}
                                    aria-controls=${`${alternativesId}-import`}
                                    disabled=${busy || !active}
                                    onClick=${() => chooseWay("import")}
                                ><${Icon} name="copy" size=${18} /> Import from Pi</button>`
                            }
                            ${
                                owner &&
                                canStart &&
                                html`<button
                                    class="button"
                                    type="button"
                                    aria-pressed=${mode === "one-time"}
                                    aria-controls=${`${alternativesId}-one-time`}
                                    disabled=${busy || !active}
                                    onClick=${() => chooseWay("one-time")}
                                ><${Icon} name="chat" size=${18} /> One-time Chat</button>`
                            }
                        </div>
                        ${canStart && !project && html`<p id=${`${alternativesId}-project-hint`} class="small muted">Choose a project above to start a Work Item.</p>`}
                        ${
                            canStart &&
                            html`<div
                                id=${`${alternativesId}-work`}
                                key="work-options"
                                class="home-work-options home-alternative-flow"
                                hidden=${!showWork || !project}
                            >
                                <h2>New Work Item</h2>
                                <${ProjectSessionPanel}
                                    key="work"
                                    projectId=${project?.id ?? null}
                                    cwd=${homeCreation?.cwd}
                                    continuation=${homeCreation?.continuation}
                                    embedded=${true}
                                    visible=${Boolean(active && !creating && showWork && project)}
                                    onBusyChange=${setBusy}
                                />
                            </div>`
                        }
                        ${
                            owner &&
                            canStart &&
                            html`<div
                                id=${`${alternativesId}-one-time`}
                                key="one-time-options"
                                class="home-one-time-options home-alternative-flow"
                                hidden=${mode !== "one-time"}
                            >
                                <h2>One-time Chat</h2>
                                <p class="small muted">A standalone Chat, without a named agent or Work Item.</p>
                                <${ProjectSessionPanel}
                                    key="one-time"
                                    cwd=${homeCreation?.cwd}
                                    embedded=${true}
                                    oneTime=${true}
                                    visible=${active && !creating && otherOpen && mode === "one-time"}
                                    onBusyChange=${setBusy}
                                />
                            </div>`
                        }
                        ${
                            importAllowed &&
                            html`<div
                                id=${`${alternativesId}-import`}
                                key="import-options"
                                class="home-import-options home-alternative-flow"
                                hidden=${mode !== "import"}
                            >
                                <h2>Import from Pi</h2>
                                ${
                                    importVisited &&
                                    html`<${ImportPanel}
                                    visible=${active && !creating && otherOpen && mode === "import"}
                                    idPrefix=${`${alternativesId}-import`}
                                    isCurrentOpening=${importOpening}
                                    isActive=${importActive}
                                    onBusyChange=${setBusy}
                                    onComplete=${(id) => navigate(id)}
                                />`
                                }
                            </div>`
                        }
                    </div>
                </section>`
            }
            ${
                error &&
                html`<p class="error" role="alert">${error}</p>
                <button class="button" onClick=${reload}>Retry loading projects</button>`
            }
            ${
                recent.length > 0 &&
                !creating &&
                html`<section class="home-recent" aria-label="Recent sessions">
                <h2>Jump back in</h2>
                ${recent.map(
                    (session, index) => html`<button
                    class="splash-row"
                    data-part="home-recent-row"
                    onClick=${() => navigate(rowOpenId(session))}
                >
                    <span class="splash-key">${index + 1}</span>
                    <span class="splash-title">${session.title ?? "New session"}</span>
                </button>`,
                )}
            </section>`
            }
        </div>
    </main>`;
}
