// Project membership comes from the access-filtered catalogue, never a folder or named identity.
import { canSteer, navigate, openSheet, scoped, store } from "./store.js";
import { html, Icon, Loader, shortPath, timeAgo } from "./ui.js";
import { NamedAgentAvatar } from "./named-agent-avatar.js";
import { projectAgentContext } from "./project-groups.js";
import { ThreadTypeTag } from "./thread-type.js";
import { rowOpenId, workItemRows } from "./work-items.js";

const keyOf = (row) => row.workItemId ?? `thread:${row.id}`;
const isChat = (row) => !row.workItemId && row.threadType === "chat";
const modified = (event) => event.metaKey || event.ctrlKey || event.shiftKey || event.altKey;

function projectThreads(projectId) {
    const sessions = store.state.sessions.filter((session) => session.projectId === projectId);
    const listed = new Set(sessions.map((session) => session.id));

    // Named chats are deliberately absent from Collab. Only their actual native placement counts;
    // an identity's remit or the project's default PiP never assigns its other chats here.
    const chats =
        store.state.me?.role === "owner"
            ? (store.state.namedAgents ?? []).flatMap((agent) =>
                  (agent.chats ?? [])
                      .filter((chat) => chat.projectId === projectId && !listed.has(chat.id))
                      .map((chat) => ({
                          ...chat,
                          threadType: "chat",
                          pipAgentId: agent.agentId,
                          agentName: agent.name,
                      })),
              )
            : [];

    return [...sessions, ...chats];
}

function ProjectRow({ row, projectId, userId, exact = false }) {
    const destination = exact ? row.id : rowOpenId(row);
    const identity = store.state.namedAgents?.find((agent) => agent.agentId === row.pipAgentId);
    const activity = row.waiting ? "Needs attention" : row.busy || row.managing ? "Working" : "";

    return html`<a
        class="project-view-row"
        href=${`/s/${destination}`}
        onClick=${(event) => {
            if (modified(event)) {
                return;
            }

            event.preventDefault();

            if (
                store.state.me?.id !== userId ||
                !store.state.projects.some((project) => project.id === projectId)
            ) {
                return;
            }

            const sessions = projectThreads(projectId);
            const current = exact
                ? sessions.find((session) => session.id === row.id)
                : workItemRows(sessions).find((each) => keyOf(each) === keyOf(row));

            if (current) {
                navigate(exact ? current.id : rowOpenId(current));
            }
        }}
    >
        ${
            identity
                ? html`<${NamedAgentAvatar}
                    agentId=${identity.agentId}
                    animated=${true}
                    thinking=${row.busy || row.managing}
                />`
                : row.members && row.supervisor
                  ? html`<${Icon} name="pip" size=${18} />`
                  : html`<${ThreadTypeTag} session=${row} iconOnly=${true} />`
        }
        <span class="project-view-row-main">
            <span class="project-view-row-title">${row.title || "New session"}</span>
            <span class="small muted project-view-row-context">
                ${row.agentName ?? (exact ? `Thread ${row.id}` : row.workItemId ? "Work Item" : isChat(row) ? "Chat" : "Session")}
                ${row.branch?.branch ? ` · ${row.branch.branch}` : row.branch?.detached ? ` · ${row.branch.detached} (detached)` : ""}
            </span>
        </span>
        <span class="project-view-row-status small muted">
            ${activity || (row.updatedAt ? timeAgo(row.updatedAt) : "Ready")}
        </span>
        <${Icon} name="chevron" size=${14} />
    </a>`;
}

function ProjectRows({ rows, projectId, userId }) {
    return html`<ul class="project-view-list">
        ${rows.map(
            (row) => html`<li key=${keyOf(row)}>
                <${ProjectRow} row=${row} projectId=${projectId} userId=${userId} />
                ${
                    row.members &&
                    html`<details class="project-view-threads">
                        <summary>Threads (${row.members.length})</summary>
                        <ul class="project-view-list">
                            ${row.members.map(
                                (member) => html`<li key=${member.id}>
                                    <${ProjectRow}
                                        row=${member}
                                        projectId=${projectId}
                                        userId=${userId}
                                        exact=${true}
                                    />
                                </li>`,
                            )}
                        </ul>
                    </details>`
                }
            </li>`,
        )}
    </ul>`;
}

export function ProjectView({ projectId, onBack }) {
    const { projects, me, server, namedAgents } = store.state;
    const project = projects.find((each) => each.id === projectId);
    const userId = me?.id;
    const liveProject = () =>
        store.state.me?.id === userId && store.state.projects.some((each) => each.id === projectId);
    const back = html`<button
        class="button project-view-back"
        type="button"
        aria-label="Back to sessions"
        onClick=${onBack}
    >
        <${Icon} name="back" size=${16} /> Sessions
    </button>`;

    if (!project && !store.state.projectsLoaded) {
        return html`<main class="scroller project-view" aria-label="Loading project">
            <div class="project-view-content">${back}<${Loader} label="Loading project" /></div>
        </main>`;
    }

    if (!project) {
        return html`<main class="scroller project-view" aria-label="Project unavailable">
            <div class="project-view-content">
                ${back}
                <h1>Project unavailable</h1>
                <p class="muted">This project is no longer available to you. Choose another project from the session list.</p>
            </div>
        </main>`;
    }

    const owner = me?.role === "owner";
    const canStart = !!me && canSteer() && !scoped();
    const rows = workItemRows(projectThreads(projectId));
    const active = rows.filter((row) => !row.archived);
    const archived = rows.filter((row) => row.archived);
    const work = active.filter((row) => !isChat(row));
    const chats = active.filter(isChat);
    const { defaultAgent, relatedAgents } = projectAgentContext(project, owner ? namedAgents : []);
    const location = project.location?.kind === "ssh" ? project.location.host : "Local";

    return html`<main class="scroller project-view" aria-label=${project.name}>
        <div class="project-view-content">
            ${back}
            <header class="project-view-header">
                <h1>${project.name}</h1>
                <div class="project-view-actions">
                    ${
                        owner &&
                        html`<button
                            class="button"
                            type="button"
                            onClick=${() => {
                                if (liveProject() && store.state.me?.role === "owner") {
                                    openSheet({ type: "project", projectId });
                                }
                            }}
                        >
                            <${Icon} name="settings" size=${16} /> Project settings
                        </button>`
                    }
                    ${
                        canStart &&
                        html`<button
                            class="button primary"
                            type="button"
                            onClick=${() => {
                                if (liveProject() && canSteer() && !scoped()) {
                                    openSheet({ type: "new-session", projectId });
                                }
                            }}
                        >
                            <${Icon} name="plus" size=${16} /> New Session
                        </button>`
                    }
                </div>
            </header>
            <dl class="project-view-context small">
                <div><dt>Machine</dt><dd>${location}</dd></div>
                ${
                    project.cwd &&
                    html`<div>
                        <dt>Directory</dt>
                        <dd title=${project.cwd}>${shortPath(project.cwd, server?.home)}</dd>
                    </div>`
                }
                ${
                    owner &&
                    project.defaultAgentId &&
                    html`<div>
                        <dt>Default PiP</dt>
                        <dd class="project-view-agent">
                            ${
                                defaultAgent &&
                                html`<${NamedAgentAvatar}
                                    agentId=${defaultAgent.agentId}
                                    size=${24}
                                    animated=${true}
                                    thinking=${defaultAgent.busy || defaultAgent.managing}
                                />`
                            }
                            <span>${defaultAgent?.name ?? "Unavailable named agent"}</span>
                        </dd>
                    </div>`
                }
                ${
                    owner &&
                    relatedAgents.length > 0 &&
                    html`<div>
                        <dt>Related PiPs</dt>
                        <dd>
                            ${relatedAgents.map(
                                (agent) => html`<span class="project-view-agent">
                                <${NamedAgentAvatar} agentId=${agent.agentId} size=${24} />
                                <span>${agent.name}${agent.agentId === project.defaultAgentId ? " (default)" : ""}</span>
                            </span>`,
                            )}
                            ${!project.defaultAgentId && html`<span class="small muted">No default selected. Choose an agent when starting a Chat, or set a project default.</span>`}
                        </dd>
                    </div>`
                }
            </dl>
            <section class="project-view-section" aria-label="Work Items">
                <h2>Work Items <span class="muted small">${work.length}</span></h2>
                ${
                    work.length
                        ? html`<${ProjectRows} rows=${work} projectId=${projectId} userId=${userId} />`
                        : html`<p class="muted project-view-empty">No work here yet. Start a session to work in this project.</p>`
                }
            </section>
            <section class="project-view-section" aria-label="Chats">
                <h2>Chats <span class="muted small">${chats.length}</span></h2>
                ${
                    chats.length
                        ? html`<${ProjectRows} rows=${chats} projectId=${projectId} userId=${userId} />`
                        : html`<p class="muted project-view-empty">No chats in this project yet.</p>`
                }
            </section>
            ${
                archived.length > 0 &&
                html`<details class="project-view-archive">
                    <summary>Archived (${archived.length})</summary>
                    <${ProjectRows} rows=${archived} projectId=${projectId} userId=${userId} />
                </details>`
            }
        </div>
    </main>`;
}
