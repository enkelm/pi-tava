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
    goalId: initialGoalId,
    newGoal: initialNewGoal = false,
    cwd: initialCwd,
    continuation,
    visible,
    onBusyChange,
}) {
    const { projects, projectGoals, projectsLoaded, server } = store.state;
    const [projectId, setProjectId] = useState(initialProjectId ?? null);
    const [goalId, setGoalId] = useState(initialGoalId ?? null);
    const [newGoal, setNewGoal] = useState(initialNewGoal);
    const [chat, setChat] = useState(false);
    const [threadType, setThreadType] = useState("worker");
    const [creating, setCreating] = useState(false);
    const [override, setOverride] = useState(initialCwd ?? null);
    const [browse, setBrowse] = useState(false);
    const [worktree, setWorktree] = useState(false);
    const [busy, setBusy] = useState(false);
    const [error, setError] = useState("");
    const requestId = useRef(uid());
    const project = projects.find((each) => each.id === projectId);
    const goal = projectGoals.find((each) => each.id === goalId && each.projectId === projectId);
    const cwd = override ?? (!chat ? project?.cwd : null) ?? server?.defaultCwd ?? "~";
    const noProjects = projectsLoaded && projects.length === 0;
    const pullAvailable = (server?.handoffs ?? 0) >= 2;
    const researcherAvailable = (server?.handoffs ?? 0) >= 4;
    const typeLabel = threadTypeLabel({ threadType });

    const leaveChat = () => {
        setChat(false);
        setThreadType("worker");
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
        setGoalId(null);
        setNewGoal(false);
        setOverride(initialCwd ?? null);
        setError("");
        requestId.current = uid();
    };

    const chooseGoal = (id, create = false) => {
        setGoalId(id);
        setNewGoal(create);
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
        if (busy || (!chat && !project)) {
            return;
        }

        setBusy(true);
        onBusyChange(true);
        setError("");

        try {
            const created = await actions.createSession(override ?? undefined, {
                threadType,
                ...(chat
                    ? {}
                    : {
                          projectId,
                          ...(goal ? { goalId } : {}),
                          ...(newGoal ? { newGoal: true } : {}),
                      }),
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
        const goals = projectGoals.filter((item) => item.projectId === each.id && !item.archived);

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
            ${
                selected &&
                html`<div
                    class="project-goal-choices"
                    role="group"
                    aria-label=${`Goals in ${each.name}`}
                >
                    <button
                        class=${`list-item ${newGoal ? "active" : ""}`}
                        aria-pressed=${newGoal}
                        disabled=${busy}
                        onClick=${() => chooseGoal(null, true)}
                    >
                        <span><${Icon} name="plus" size=${15} /> New Goal</span>
                    </button>
                    ${goals.map(
                        (item) => html`<button
                            key=${item.id}
                            class=${`list-item ${goalId === item.id ? "active" : ""}`}
                            aria-pressed=${goalId === item.id}
                            disabled=${busy}
                            onClick=${() => chooseGoal(item.id)}
                        >
                            <span><${Icon} name="target" size=${15} /> ${item.name}</span>
                            ${
                                item.status === "completed" &&
                                html`<span class="muted small">Completed</span>`
                            }
                        </button>`,
                    )}
                    <button
                        class=${`list-item ${!goalId && !newGoal ? "active" : ""}`}
                        aria-pressed=${!goalId && !newGoal}
                        disabled=${busy}
                        onClick=${() => chooseGoal(null)}
                    >
                        <span>No goal</span>
                    </button>
                </div>`
            }
        </section>`;
    };

    return html`<div class="project-session-flow">
        ${
            chat
                ? html`<div class="one-time-chat">
                    <button class="button small" disabled=${busy} onClick=${leaveChat}>
                        <${Icon} name="back" size=${14} /> Projects
                    </button>
                    <p>A one-time ${typeLabel} stays outside projects and goals.</p>
                </div>`
                : html`
                    <p class="muted small">Choose a project for this ${typeLabel}, then a goal if you need one.</p>
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
                ${
                    pullAvailable &&
                    html`<label>
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
                            <option value=${chat ? "chat" : "worker"}>${chat ? "Chat" : "Worker"}</option>
                            ${researcherAvailable && html`<option value="researcher">Researcher</option>`}
                            <option value="pull">Pull</option>
                        </select>
                    </label>`
                }
                ${threadType === "researcher" && html`<p class="muted small">Investigate a pointed question and return findings for the next stage.</p>`}
                ${threadType === "pull" && html`<p class="muted small">Read tickets and PRs, agree on direction with a human or collect a handoff, and update worktrees.</p>`}
                ${
                    !chat &&
                    html`<p class="small">
                        <b>${project.name}</b>${newGoal ? " · New Goal" : goal ? ` · ${goal.name}` : " · No goal"}
                        ${
                            newGoal &&
                            html`<span class="muted goal-naming-note">Pi names the goal from your first thread prompt.</span>`
                        }
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
                <button class="button primary wide" disabled=${busy} onClick=${start}>
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
