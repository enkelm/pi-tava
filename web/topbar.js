// Named-agent chrome is independent of the ordinary conversation/workspace header.
import { Fragment } from "preact";
import { useEffect, useState } from "preact/hooks";
import { AgentHistory } from "./agent-history.js";
import { selectedAgentDraft } from "./agent-drafts.js";
import { openAgentSettings } from "./named-agents.js";
import { NamedAgentAvatar } from "./named-agent-avatar.js";
import { folderColor } from "./avatar.js";
import { BrowserButton } from "./browser-panel.js";
import { PeopleButton } from "./chat.js";
import { useChanges } from "./diff.js";
import { FilesButton, filesAvailable, setFilesOpen } from "./files-panel.js";
import { ExtensionSessionControls } from "./extension-ui.js";
import { PeeksButton } from "./peeks.js";
import { toSessions } from "./sessions.js";
import { branchAvailable, headLabel } from "./sheets/branch.js";
import { openSubagents } from "./subagents.js";
import { api, closeSheet, navigate, openSheet, projectsAvailable, store } from "./store.js";
import { ThreadTypeTag } from "./thread-type.js";
import { conversationLocation } from "./workspace-location.js";
import { html, Icon, item, Sheet, shortPath, useEdge } from "./ui.js";
import { AgentTabs, tabAgent, tabChromeAgent } from "./agent-tabs.js";

/** What changed in the session's folder: lines added and removed, and how many files. It opens Changes. */
function ChangesButton() {
    const { changes } = useChanges();
    // Outside a repository Pi's edits are all there is to review (in one, they are what was committed since).
    const files = [...(changes?.files ?? []), ...(changes?.repo ? [] : (changes?.piOnly ?? []))];

    if (files.length === 0) {
        return null;
    }

    // Git counts the lines of changed files, not of new or binary ones: each side shows when it has some.
    const added = files.reduce((sum, file) => sum + (file.added ?? 0), 0);
    const removed = files.reduce((sum, file) => sum + (file.removed ?? 0), 0);
    const lines = added > 0 || removed > 0;
    const count = files.length + (changes.more ?? 0);
    const counted = `${count} ${count === 1 ? "file" : "files"}`;

    return html`<button
        class="changes-button"
        title="Uncommitted changes in this session's folder"
        aria-label=${`Changes: ${counted}${lines ? `, ${added} lines added and ${removed} removed` : ""}`}
        onClick=${() => setFilesOpen(true, "changes")}
    >
        ${added > 0 && html`<span class="added">+${added}</span>`}
        ${removed > 0 && html`<span class="removed">−${removed}</span>`}
        <span class=${lines ? "changes-files" : ""}>${counted}</span>
    </button>`;
}

function ConversationTopbar() {
    const { view, server, conversationId } = store.state;
    const conversation = view.conversation;
    const controller =
        conversation?.kind === "session" &&
        conversation.id === conversationId &&
        Boolean(conversation.workSupervisor);
    const artifacts = view.artifacts?.length ?? 0;
    const cwd = view.agent?.cwd ?? conversation?.cwd;
    const location = conversationLocation();
    const destination = location?.kind === "ssh" ? `SSH · ${location.host} · ${cwd ?? ""}` : null;
    const folder = String(cwd ?? "")
        .replace(/\/+$/, "")
        .split("/")
        .pop();
    const branch = headLabel(view.branch) || conversation?.worktree?.branch;
    const title =
        conversation?.title ??
        store.state.sessions.find((session) => session.id === store.state.conversationId)?.title ??
        (store.state.missing ? "Not found" : "Loading…");
    const busySubagents = (view.subagents ?? []).filter((agent) => agent.busy).length;
    // Other sessions waiting for an approval, counted on the way back to them.
    const waiting = store.state.sessions.filter(
        (session) =>
            session.waiting && !session.archived && session.id !== store.state.conversationId,
    ).length;
    // How far down it reaches: PiP's window on a short wide screen stops below its buttons.
    const edge = useEdge("--topbar-h", (rect) => rect.bottom);

    return html`<header
        class="topbar"
        data-part="topbar"
        ref=${edge}
    >
        <button
            class="icon-button badge-host topbar-back"
            aria-label=${waiting > 0 ? `Back to sessions, ${waiting} waiting for you` : "Back to sessions"}
            title="Sessions"
            onClick=${toSessions}
        >
            <${Icon} name="back" size=${22} />
            ${waiting > 0 && html`<span class="badge warn">${waiting}</span>`}
        </button>
        <div class="title">
            <button
                class="title-open"
                aria-label=${`${title}${destination ? `, ${destination}` : folder ? `, in ${folder}` : ""}: session menu`}
                title=${destination ?? (cwd ? `${shortPath(cwd, server?.home)}\nSession menu` : "Session menu")}
                disabled=${!conversation}
                onClick=${() => openSheet({ type: "menu" })}
            ></button>
            <span
                class="title-main"
                data-part="topbar-title"
                aria-hidden=${controller ? undefined : "true"}
            >
                ${
                    controller
                        ? html`<${ThreadTypeTag} session=${conversation} iconOnly=${true} />
                          <span aria-hidden="true">${` ${title.replace(/^PiP · /, "· ")}`}</span>`
                        : title
                }
            </span>
            <span class="title-sub" data-part="topbar-sub">
                ${
                    projectsAvailable() &&
                    conversation?.kind === "session" &&
                    !controller &&
                    html`<${ThreadTypeTag} session=${conversation} />`
                }
                ${conversation?.imported && html`<span class="muted" title="Copied from a saved Pi session; the original Pi was not stopped">Imported from Pi</span>`}
                ${
                    folder &&
                    !destination &&
                    html`<span
                        class="folder-mark"
                        style=${`--folder:${folderColor(cwd)}`}
                        aria-hidden="true"
                    ></span>`
                }
                ${
                    conversation?.kind === "subagent"
                        ? html`<span class="title-folder title-parent">
                              subagent of ${conversation.parent?.title ?? "?"}
                          </span>`
                        : html`${
                              destination
                                  ? html`<span class="title-destination" aria-hidden="true">${destination}</span>`
                                  : folder &&
                                    html`<span class="title-folder" aria-hidden="true">${folder}</span>`
                          }
                          ${
                              branch &&
                              (branchAvailable()
                                  ? html`<button
                                        class="title-branch"
                                        aria-label=${view.branch?.detached ? `No branch, at ${branch}: switch to one` : `Branch ${branch}: switch or make a branch`}
                                        title=${view.branch?.detached ? "No branch: switch to one" : "Switch or make a branch"}
                                        onClick=${() => openSheet({ type: "branch" })}
                                    >
                                        <${Icon} name="fork" size=${10} /><span
                                            class="title-branch-name"
                                            >${branch}</span
                                        >
                                    </button>`
                                  : html`<span class="title-branch" title="The git branch">
                                        <${Icon} name="fork" size=${10} /><span
                                            class="title-branch-name"
                                            >${branch}</span
                                        >
                                    </span>`)
                          }
                          ${
                              conversation?.worktree &&
                              html`<span class="title-worktree" aria-hidden="true">worktree</span>`
                          }`
                }
            </span>
        </div>
        ${
            busySubagents > 0 &&
            html`<button
                class="icon-button"
                aria-label=${`Subagents: ${busySubagents} working`}
                title="Subagents working"
                onClick=${openSubagents}
            >
                <span class="pulse"></span>
                <span class="count">${busySubagents}</span>
            </button>`
        }
        ${filesAvailable() && html`<${ChangesButton} key=${conversationId} />`}
        <${ExtensionSessionControls} slot="header" />
        <${PeeksButton} />
        <${FilesButton} />
        <${BrowserButton} />
        <button
            class=${`icon-button badge-host ${artifacts > 0 ? "quiet-phone" : "quiet"}`}
            aria-label="Artifacts"
            title="Artifacts"
            onClick=${() => openSheet({ type: "artifacts" })}
        >
            <${Icon} name="artifact" />
            ${artifacts > 0 && html`<span class="badge">${artifacts}</span>`}
        </button>
        <${PeopleButton} />
        <button
            class="icon-button"
            aria-label="Menu"
            title="Menu"
            aria-haspopup="dialog"
            aria-expanded=${store.state.sheet?.type === "menu"}
            onClick=${() => openSheet({ type: "menu" })}
        >
            <${Icon} name="more" />
        </button>
    </header>`;
}

/** A passive read pinned to the selected saved chat and owner; no authority mutations. */
function useChatOrchestrators({ agent, source, current }) {
    const available = current();
    const [read, setRead] = useState({ loading: true });
    const [revision, setRevision] = useState(0);

    useEffect(() => {
        if (!Number.isSafeInteger(source)) {
            setRead({ loading: false, draft: true });

            return;
        }

        if (!current()) {
            return;
        }

        const stop = new AbortController();
        let active = true;
        const live = () => active && !stop.signal.aborted && current();

        setRead({ loading: true });
        api(`c/${source}/private-agent`, undefined, { signal: stop.signal }).then(
            (data) => {
                if (!live()) {
                    return;
                }

                if (
                    data.id !== source ||
                    data.agentId !== agent.agentId ||
                    !Array.isArray(data.controllers)
                ) {
                    setRead({
                        loading: false,
                        error: "The response did not match this chat. Refresh to retry.",
                    });

                    return;
                }

                setRead({ loading: false, data });
            },
            (failure) => {
                if (live()) {
                    setRead({
                        loading: false,
                        error: failure.message || "Could not load orchestrators.",
                    });
                }
            },
        );

        return () => {
            active = false;
            stop.abort();
        };
    }, [
        source,
        available,
        agent.agentId,
        agent.controlRevision,
        store.state.connection,
        store.state.server?.pipEnabled,
        store.state.server?.workItemsEnabled,
        revision,
    ]);

    return { read, refresh: () => current() && setRevision((value) => value + 1) };
}

function ControllerLink({ controller, current, close, compact = false }) {
    if (controller.accessible === false) {
        return html`<div class="named-agent-controller-link" aria-disabled="true">
            <span>Unavailable Work Item</span>
            <span class="small muted">Unavailable</span>
        </div>`;
    }

    return html`<a
        class=${compact ? "agent-current-controller" : "named-agent-controller-link"}
        href=${`/s/${controller.conversationId}`}
        aria-label=${`Open ${compact ? "current " : ""}orchestrator for ${controller.title}, ${controller.state}`}
        title=${`${controller.title}: ${controller.state}`}
        onClick=${(event) => {
            if (!current()) {
                event.preventDefault();

                return;
            }

            if (event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) {
                return;
            }

            event.preventDefault();
            close?.(false);
            navigate(controller.conversationId);
        }}
    >
        <span>${controller.title}</span>
        <span class="small muted">${controller.state}</span>
    </a>`;
}

function ChatOrchestrators({ agent, source, current, close }) {
    const { read, refresh } = useChatOrchestrators({ agent, source, current });
    const all = read.data?.controllers ?? [];
    const known = all.every((item) => typeof item.current === "boolean");
    const currentControllers = all.filter(
        (item) => item.current === true && item.accessible !== false,
    );
    const links = (controllers) => html`<ul class="named-agent-controllers">
        ${controllers.map(
            (controller) => html`<li key=${controller.workItemId}>
            <${ControllerLink} controller=${controller} current=${current} close=${close} />
            ${
                controller.accessible === false
                    ? html`<p class="small muted">This Work Item is no longer accessible.</p>`
                    : controller.reason && html`<p class="small muted">${controller.reason}</p>`
            }
        </li>`,
        )}
    </ul>`;

    return html`<div class="agent-orchestrators named-agent-form" aria-busy=${read.loading}>
        <p class="small muted">
            Links open native conversations without activating work. Current control is scoped to this saved chat.
        </p>
        ${read.loading && html`<p role="status">Loading orchestrators…</p>`}
        ${read.draft && html`<p>This unsent chat has no current orchestrators.</p>`}
        ${read.error && html`<p role="alert">${read.error}</p>`}
        ${
            read.data &&
            html`<section class="named-agent-section">
            <h3>Current for this chat</h3>
            ${
                !known
                    ? html`<p class="small muted">Current-chat status is unavailable from this server.</p>`
                    : currentControllers.length === 0
                      ? html`<p class="small muted">No current orchestrators for this chat.</p>`
                      : links(currentControllers)
            }
        </section>
        <details>
            <summary>All Work Items for this chat (${all.length})</summary>
            <p class="small muted">
                Current, historical and passive contacts for this chat; only the current section above represents current control.
            </p>
            ${all.length ? links(all) : html`<p class="small muted">No Work Item contacts yet.</p>`}
        </details>`
        }
        ${
            !read.draft &&
            html`<button
            class="button"
            type="button"
            disabled=${read.loading}
            onClick=${refresh}
        >Refresh</button>`
        }
    </div>`;
}

/** Header actions keep their originating owner, identity and chat even across sheet transitions. */
function agentHeaderControls({ agent, source, userId, sheet }) {
    const savedId = Number.isSafeInteger(source) ? source : null;
    const memoryEnabled = store.state.server?.extensions?.includes("pocket-memory") === true;
    const unavailable = (label) => label === "Memory" && !memoryEnabled;
    const actionTitle = (label) =>
        unavailable(label) ? "Enable Memory in Extensions to use this agent's memory" : label;
    const sameContext = (identity) =>
        store.state.me?.id === userId &&
        identity?.agentId === agent.agentId &&
        (selectedAgentDraft()?.id ?? store.state.conversationId) === source &&
        (!sheet || store.state.sheet === sheet);
    const current = () => sameContext(tabAgent());
    const localCurrent = () => sameContext(tabChromeAgent());
    const close = () => (sheet?.panel === "chats" ? localCurrent() : current()) && closeSheet();

    const show = (panel) => {
        if (panel === "chats" ? localCurrent() : current()) {
            openSheet({ type: "agent-header", panel, agentId: agent.agentId, source, userId });
        }
    };

    const settings = (section) => {
        if (current()) {
            openAgentSettings(savedId, agent.agentId, section);
        }
    };

    const memory = () => {
        if (current() && store.state.server?.extensions?.includes("pocket-memory") === true) {
            openSheet({ type: "memory", conversationId: savedId ?? `agent:${agent.agentId}` });
        }
    };

    const actions = [
        ["History", () => show("history")],
        ["Memory", memory],
        ["Goal / purpose", () => settings("focus")],
        ["System prompt", () => settings("instructions")],
        ["Rename", () => settings("name")],
        ["Agent settings", () => settings()],
        ["All Work Items", () => show("orchestrators")],
    ];

    return {
        current,
        localCurrent,
        close,
        show,
        settings,
        memory,
        actions,
        unavailable,
        actionTitle,
    };
}

/** Named-agent actions live in the native app menu, including before a chat's first Send. */
export function AgentMenuItems({ sheet = store.state.sheet }) {
    const agent = tabAgent();

    if (!agent || sheet?.type !== "menu" || store.state.sheet !== sheet) {
        return null;
    }

    const source = selectedAgentDraft()?.id ?? store.state.conversationId;
    const { actions, unavailable, actionTitle } = agentHeaderControls({
        agent,
        source,
        userId: store.state.me.id,
        sheet,
    });

    return html`<div class="agent-menu-actions" aria-label=${`${agent.name} actions`}>
        ${actions.map(([label, action]) =>
            item(label, action, undefined, {
                disabled: unavailable(label),
                title: actionTitle(label),
            }),
        )}
    </div>`;
}

function NamedAgentTopbar({ agent, source, userId }) {
    const edge = useEdge("--topbar-h", (rect) => rect.bottom);
    const { current, localCurrent, show, settings, memory, unavailable, actionTitle } =
        agentHeaderControls({
            agent,
            source,
            userId,
        });
    const sheet = store.state.sheet;
    const panel =
        sheet?.type === "agent-header" &&
        sheet.agentId === agent.agentId &&
        sheet.source === source &&
        sheet.userId === userId
            ? sheet.panel
            : null;
    const { read } = useChatOrchestrators({ agent, source, current });
    const currentControllers = (read.data?.controllers ?? []).filter(
        (item) => item.current === true && item.accessible !== false,
    );
    const working = currentControllers.filter((item) => item.state === "active").length;
    const controllerState = read.loading
        ? "Loading orchestrators"
        : read.error
          ? "Orchestrators unavailable"
          : `${currentControllers.length} current orchestrator${currentControllers.length === 1 ? "" : "s"}${working ? `, ${working} active` : ""}`;

    return html`<${Fragment}>
        <style>@import url("/named-agents.css") layer(pocket);</style>
        <header class="topbar agent-topbar" data-part="topbar" ref=${edge}>
            <button
                class="icon-button topbar-back"
                aria-label="Back to sessions"
                title="Sessions"
                onClick=${() => localCurrent() && toSessions()}
            ><${Icon} name="back" size=${22} /></button>
            <button
                class="icon-button agent-header-avatar"
                aria-label=${`${agent.name}: settings`}
                title=${`${agent.name}: settings`}
                onClick=${() => settings()}
            ><${NamedAgentAvatar} agentId=${agent.agentId} /></button>
            <${AgentTabs}
                onChoose=${() => show("chats")}
                expanded=${panel === "chats"}
            />
            <nav class="agent-current-orchestrators" aria-label="Current orchestrators for this chat">
                ${currentControllers.map(
                    (controller) => html`<${ControllerLink}
                    key=${controller.workItemId}
                    controller=${controller}
                    current=${current}
                    compact=${true}
                />`,
                )}
            </nav>
            <button
                class=${`icon-button agent-controller-summary ${working ? "on" : ""}`}
                aria-label=${`${controllerState}: all Work Items for this chat`}
                title=${`${controllerState} · All Work Items for this chat`}
                aria-haspopup="dialog"
                aria-expanded=${panel === "orchestrators"}
                onClick=${() => show("orchestrators")}
            >
                <${Icon} name="pip" size=${18} />
                ${!read.loading && !read.error && currentControllers.length > 0 && html`<span class="count">${currentControllers.length}</span>`}
            </button>
            <div class="agent-header-context" aria-label="Agent context">
                <button
                    class="icon-button"
                    aria-label="Memory"
                    title=${actionTitle("Memory")}
                    disabled=${unavailable("Memory")}
                    onClick=${memory}
                ><${Icon} name="brain" size=${18} /></button>
            </div>
            <button
                class="icon-button agent-header-history"
                aria-label="History"
                title="Saved chat history"
                aria-haspopup="dialog"
                aria-expanded=${panel === "history"}
                onClick=${() => show("history")}
            ><${Icon} name="clock" size=${18} /></button>
            <button
                class="icon-button topbar-menu"
                aria-label="Menu"
                title="Menu"
                aria-haspopup="dialog"
                aria-expanded=${sheet?.type === "menu"}
                onClick=${() => current() && openSheet({ type: "menu" })}
            ><${Icon} name="more" /></button>
        </header>
    </${Fragment}>`;
}

/** Registered by sheets.js so keyboard dismissal, focus and Back share the native modal owner. */
export function AgentHeaderSheet({ sheet }) {
    const { source, userId, panel } = sheet;
    const agent = panel === "chats" ? tabChromeAgent() : tabAgent();

    if (
        !agent ||
        !["history", "orchestrators", "chats"].includes(panel) ||
        agent.agentId !== sheet.agentId ||
        store.state.me?.id !== userId ||
        (selectedAgentDraft()?.id ?? store.state.conversationId) !== source
    ) {
        return null;
    }

    const { current, close } = agentHeaderControls({
        agent,
        source,
        userId,
        sheet,
    });

    return html`<${Sheet}
        title=${
            panel === "history"
                ? `${agent.name} · History`
                : panel === "orchestrators"
                  ? "Orchestrators"
                  : `${agent.name} chats`
        }
        onClose=${close}
    >
        ${
            panel === "history"
                ? html`<${AgentHistory} agent=${agent} source=${source} current=${current} close=${close} />`
                : panel === "orchestrators"
                  ? html`<${ChatOrchestrators} agent=${agent} source=${source} current=${current} close=${close} />`
                  : html`<${AgentTabs} picker=${true} close=${close} />`
        }
    </${Sheet}>`;
}

export function Topbar() {
    const agent = tabChromeAgent();

    if (agent) {
        const { me, conversationId } = store.state;
        const source = selectedAgentDraft()?.id ?? conversationId;

        return html`<${NamedAgentTopbar}
            key=${`${me.id}:${agent.agentId}:${source}`}
            agent=${agent}
            source=${source}
            userId=${me.id}
        />`;
    }

    return html`<${ConversationTopbar} />`;
}
