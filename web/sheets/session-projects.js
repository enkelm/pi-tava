// Start new chooses organization first; the server resolves a project's default cwd.
import { useEffect, useRef, useState } from "preact/hooks";
import { useBack } from "../back.js";
import { actions, insertIntoComposer, navigate, store, uid } from "../store.js";
import { ThreadTypeTag, threadTypeLabel } from "../thread-type.js";
import { html, Icon, Loader, shortPath } from "../ui.js";
import { FolderPicker } from "./folder.js";
import { ProjectForm } from "./project.js";

export function ProjectSessionPanel({
    projectId: initialProjectId,
    cwd: initialCwd,
    continuation,
    visible,
    onBusyChange,
}) {
    const { projects, projectsLoaded, server } = store.state;
    const [projectId, setProjectId] = useState(initialProjectId ?? null);
    const [chat, setChat] = useState(false);
    const starters = (server?.agentProfiles ?? []).filter((profile) => profile.starter);
    const defaultStarter = starters.find((profile) => profile.id !== "chat")?.id;
    const [threadType, setThreadType] = useState(defaultStarter ?? "chat");
    const [creating, setCreating] = useState(false);
    const [override, setOverride] = useState(initialCwd ?? null);
    const [browse, setBrowse] = useState(false);
    const [worktree, setWorktree] = useState(false);
    const [busy, setBusy] = useState(false);
    const [error, setError] = useState("");
    const requestId = useRef(uid());
    const project = projects.find((each) => each.id === projectId);
    const cwd = override ?? (!chat ? project?.cwd : null) ?? server?.defaultCwd ?? "~";
    const noProjects = projectsLoaded && projects.length === 0;
    const typeLabel = threadTypeLabel({ threadType });
    const profiles = starters.filter((profile) => chat || profile.id !== "chat");
    const profileAvailable = profiles.some((profile) => profile.id === threadType);

    const leaveChat = () => {
        setChat(false);
        setThreadType(defaultStarter ?? "chat");
        requestId.current = uid();
    };

    useBack(visible && chat, leaveChat);
    useBack(visible && creating, () => setCreating(false));
    useBack(visible && browse, () => setBrowse(false));

    const reload = () => {
        setError("");
        actions.loadProjects().catch((failure) => setError(failure.message));
    };

    useEffect(() => {
        if (!store.state.projectsLoaded) {
            reload();
        }
    }, []);

    const chooseProject = (id) => {
        setProjectId(id);
        setOverride(initialCwd ?? null);
        setError("");
        requestId.current = uid();
    };

    const chooseChat = () => {
        setChat(true);
        setThreadType("chat");
        setCreating(false);
        setOverride(initialCwd ?? null);
        setBrowse(false);
        requestId.current = uid();
    };

    const start = async () => {
        if (busy || !profileAvailable || (!chat && !project)) {
            return;
        }

        setBusy(true);
        onBusyChange(true);
        setError("");

        try {
            const created = await actions.createSession(override ?? undefined, {
                threadType,
                ...(!chat ? { projectId } : {}),
                worktree,
                requestId: requestId.current,
            });

            navigate(created.id);

            if (continuation?.type === "share") {
                insertIntoComposer(continuation.share.text, continuation.share.files);
            }
        } catch (failure) {
            setError(failure.message ?? String(failure));
        } finally {
            setBusy(false);
            onBusyChange(false);
        }
    };

    if (!chat && (creating || noProjects)) {
        return html`<div class="project-session-flow">
            <${ProjectForm}
                visible=${visible}
                onBusyChange=${(working) => {
                    setBusy(working);
                    onBusyChange(working);
                }}
                onCancel=${noProjects ? undefined : () => setCreating(false)}
                onSaved=${(id) => {
                    chooseProject(id);
                    setCreating(false);
                }}
            />
            <button
                class="button wide one-time-chat-button"
                disabled=${busy}
                onClick=${chooseChat}
            >
                <${Icon} name="chat" size=${16} /> Start a one-time chat
            </button>
        </div>`;
    }

    const renderProject = (each) => {
        const selected = each.id === projectId;

        return html`<section key=${each.id} class="project-choice">
            <button
                class=${`list-item project-choice-row ${selected ? "active" : ""}`}
                aria-expanded=${selected}
                aria-pressed=${selected}
                disabled=${busy}
                onClick=${() => chooseProject(each.id)}
            >
                <span><${Icon} name="folder" size=${16} /> ${each.name}</span>
                <${Icon} name=${selected ? "down" : "chevron"} size=${14} />
            </button>
        </section>`;
    };

    return html`<div class="project-session-flow">
        ${
            chat
                ? html`<div class="one-time-chat">
                    <button class="button small" disabled=${busy} onClick=${leaveChat}>
                        <${Icon} name="back" size=${14} /> Projects
                    </button>
                    <p>A one-time ${typeLabel} stays outside projects.</p>
                </div>`
                : html`
                    <p class="muted small">Choose a project for this ${typeLabel}.</p>
                    ${!projectsLoaded && !error && html`<${Loader} label="Loading projects" />`}
                    ${
                        projectsLoaded &&
                        projects.length === 0 &&
                        html`<p class="muted">No projects yet. Create one with a name and default working directory.</p>`
                    }
                    <div class="project-choices">${projects.map(renderProject)}</div>
                    <button class="button" disabled=${busy} onClick=${() => setCreating(true)}>
                        <${Icon} name="plus" size=${15} /> New Project
                    </button>
                `
        }
        ${
            (chat || project) &&
            html`<div class="session-destination">
                ${html`<label>
                        <span class="label">Thread type</span>
                        <select
                            aria-label="Thread type"
                            value=${threadType}
                            disabled=${busy}
                            onChange=${(event) => {
                                setThreadType(event.currentTarget.value);
                                setError("");
                                requestId.current = uid();
                            }}
                        >
                            ${!profileAvailable && html`<option value=${threadType} disabled>${typeLabel} (unavailable)</option>`}
                            ${profiles.map((profile) => html`<option value=${profile.id}>${profile.name}</option>`)}
                        </select>
                    </label>`}
                ${profiles.find((profile) => profile.id === threadType)?.description && html`<p class="muted small">${profiles.find((profile) => profile.id === threadType).description}</p>`}
                ${
                    !chat &&
                    html`<p class="small">
                        <b>${project.name}</b>
                    </p>`
                }
                <div class="session-path">
                    <span class="mono" title=${cwd}>${shortPath(cwd, server?.home)}</span>
                    <button class="button small" disabled=${busy} onClick=${() => setBrowse(!browse)}>
                        ${browse ? "Hide" : "Change"}
                    </button>
                    ${
                        override !== null &&
                        html`<button
                            class="button small"
                            disabled=${busy}
                            onClick=${() => {
                                setOverride(null);
                                requestId.current = uid();
                            }}
                        >
                            Default
                        </button>`
                    }
                </div>
                ${
                    browse &&
                    html`<${FolderPicker}
                        mode="pick"
                        initialPath=${cwd}
                        onUse=${(path) => {
                            setOverride(path);
                            setBrowse(false);
                            requestId.current = uid();
                        }}
                    />`
                }
                <label class="check">
                    <input
                        type="checkbox"
                        checked=${worktree}
                        disabled=${busy}
                        onChange=${(event) => {
                            setWorktree(event.currentTarget.checked);
                            requestId.current = uid();
                        }}
                    /> In a git worktree of its own: a branch, apart from this folder
                </label>
                ${!profileAvailable && html`<p class="error" role="status">This agent profile is unavailable. Enable its workflow extension or select another available starter.</p>`}
                <button class="button primary wide" disabled=${busy || !profileAvailable} onClick=${start}>
                    <${ThreadTypeTag} session=${{ threadType }} iconOnly=${true} /> ${busy ? "Starting…" : `Start ${typeLabel}`}
                </button>
            </div>`
        }
        ${
            !chat &&
            html`<button
                class="button wide one-time-chat-button"
                disabled=${busy}
                onClick=${chooseChat}
            >
                <${Icon} name="chat" size=${16} /> Start a one-time chat
            </button>`
        }
        ${error && html`<p class="error" role="alert">${error}</p>`}
        ${
            !projectsLoaded &&
            error &&
            html`<button class="button" onClick=${reload}>Retry loading projects</button>`
        }
    </div>`;
}
