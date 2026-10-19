// Start new chooses organization first; destination controls stay behind Change.
import { useEffect, useRef, useState } from "preact/hooks";
import { useBack } from "../back.js";
import { actions, insertIntoComposer, navigate, store, uid } from "../store.js";
import { ThreadTypeTag, threadTypeLabel } from "../thread-type.js";
import { html, Icon, Loader } from "../ui.js";
import { ProjectFilters, projectsMatchingFilter } from "../project-access.js";
import { rememberSshFolder } from "../workspace-location.js";
import { WorkspaceField } from "../workspace-field.js";
import { RemoteProjectIcon } from "../ssh-status.js";
import { ProjectForm } from "./project.js";

export function ProjectSessionPanel({
    projectId: initialProjectId,
    cwd: initialCwd,
    continuation,
    visible,
    onBusyChange,
}) {
    const { projects, projectsLoaded, server, me } = store.state;
    const owner = me?.role === "owner";
    const [filter, setFilter] = useState("all");
    const [projectId, setProjectId] = useState(initialProjectId ?? null);
    const [chatChoice, setChat] = useState(false);
    const chat = owner && chatChoice;
    const starters = (server?.agentProfiles ?? []).filter((profile) => profile.starter);
    const defaultStarter = starters.find((profile) => profile.id !== "chat")?.id;
    const [threadType, setThreadType] = useState(defaultStarter ?? "chat");
    const [creating, setCreating] = useState(false);
    const [override, setOverride] = useState(initialCwd ?? null);
    const [locationOverride, setLocationOverride] = useState(undefined);
    const [worktree, setWorktree] = useState(false);
    const [busy, setBusy] = useState(false);
    const [error, setError] = useState("");
    const requestId = useRef(uid());
    const project = projects.find((each) => each.id === projectId);
    const location =
        !owner || locationOverride === undefined
            ? !chat
                ? (project?.location ?? null)
                : null
            : locationOverride;
    const remote = location?.kind === "ssh";
    const locationReady = !remote || (server?.sshWorkspaces >= 1 && location.host.trim());
    const cwd =
        (owner ? override : null) ??
        (!chat ? project?.cwd : null) ??
        (remote ? "~" : server?.defaultCwd) ??
        "~";
    const noProjects = projectsLoaded && projects.length === 0;
    const typeLabel = threadTypeLabel({ threadType });
    const profiles = starters.filter((profile) => chat || profile.id !== "chat");
    const profileAvailable = profiles.some((profile) => profile.id === threadType);
    const listed = projectsMatchingFilter(projects, filter);

    const changeLocation = (next, path) => {
        if (JSON.stringify(next ?? null) !== JSON.stringify(location ?? null)) {
            setWorktree(false);
        }

        setLocationOverride(next);
        setOverride(path);
        setError("");
        requestId.current = uid();
    };

    const leaveChat = () => {
        setChat(false);
        setLocationOverride(undefined);
        setOverride(initialCwd ?? null);
        setWorktree(false);
        setThreadType(defaultStarter ?? "chat");
        requestId.current = uid();
    };

    useBack(visible && chat, leaveChat);
    useBack(visible && creating, () => setCreating(false));

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
        setLocationOverride(undefined);
        setOverride(initialCwd ?? null);
        setWorktree(false);

        if (threadType === "chat") {
            setThreadType(defaultStarter ?? "chat");
        }

        setError("");
        requestId.current = uid();
    };

    const chooseChat = () => {
        setChat(true);
        setThreadType("chat");
        setLocationOverride(null);
        setWorktree(false);
        setCreating(false);
        setOverride(initialCwd ?? null);
        requestId.current = uid();
    };

    const start = async () => {
        if (
            me?.role === "viewer" ||
            busy ||
            !locationReady ||
            !cwd.trim() ||
            !profileAvailable ||
            (!chat && !project)
        ) {
            return;
        }

        setBusy(true);
        onBusyChange(true);
        setError("");

        try {
            // Pin the displayed destination, even if the project default changes while this is open.
            const created = await actions.createSession(cwd, {
                location,
                threadType,
                ...(!chat ? { projectId } : {}),
                worktree: owner && worktree,
                requestId: requestId.current,
            });

            if (owner) {
                rememberSshFolder(location, cwd);
            }

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

    if (owner && !chat && (creating || noProjects)) {
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
            <button class="button wide one-time-chat-button" disabled=${busy} onClick=${chooseChat}>
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
                <span>
                    ${
                        each.location?.kind === "ssh"
                            ? html`<${RemoteProjectIcon} location=${each.location} />`
                            : html`<${Icon} name="folder" size=${16} />`
                    }
                    ${each.name}
                </span>
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
                  </div>`
                : html`
                      ${!projectsLoaded && !error && html`<${Loader} label="Loading projects" />`}
                      <${ProjectFilters}
                          projects=${projects}
                          filter=${filter}
                          onChange=${setFilter}
                          disabled=${busy}
                      />
                      <div class="project-choices">${listed.map(renderProject)}</div>
                      ${
                          noProjects &&
                          html`<p class="muted small">
                              No project access yet. Ask the owner to grant a project before starting a thread.
                          </p>`
                      }
                      ${
                          projectsLoaded &&
                          !noProjects &&
                          listed.length === 0 &&
                          html`<p class="muted small">
                              No projects match this filter. Choose another machine.
                          </p>`
                      }
                      ${
                          owner &&
                          html`<button class="button" disabled=${busy} onClick=${() => setCreating(true)}>
                              <${Icon} name="plus" size=${15} /> New Project
                          </button>`
                      }
                  `
        }
        ${
            (chat || project) &&
            html`<div class="session-destination">
                <label>
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
                </label>
                <${WorkspaceField}
                    key=${chat ? "chat" : projectId}
                    location=${location}
                    cwd=${cwd}
                    visible=${visible}
                    disabled=${busy}
                    onChange=${changeLocation}
                    onReset=${
                        owner && (override !== null || locationOverride !== undefined)
                            ? () => {
                                  setOverride(null);
                                  setLocationOverride(undefined);
                                  setWorktree(false);
                                  requestId.current = uid();
                              }
                            : undefined
                    }
                >
                    ${
                        owner &&
                        html`<label class="check" title="Create a branch and checkout of its own">
                            <input
                                type="checkbox"
                                checked=${worktree}
                                disabled=${busy}
                                onChange=${(event) => {
                                    setWorktree(event.currentTarget.checked);
                                    requestId.current = uid();
                                }}
                            /> Own Git worktree
                        </label>`
                    }
                <//>
                ${owner && worktree && html`<span class="muted small">Own Git worktree</span>`}
                ${
                    !profileAvailable &&
                    html`<p class="error" role="status">
                        This agent profile is unavailable. Choose another thread type.
                    </p>`
                }
                <button
                    class="button primary wide"
                    disabled=${me?.role === "viewer" || busy || !locationReady || !cwd.trim() || !profileAvailable}
                    onClick=${start}
                >
                    <${ThreadTypeTag} session=${{ threadType }} iconOnly=${true} />
                    ${busy ? "Starting…" : `Start ${typeLabel}`}
                </button>
            </div>`
        }
        ${
            owner &&
            !chat &&
            html`<button class="button wide one-time-chat-button" disabled=${busy} onClick=${chooseChat}>
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
