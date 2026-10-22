// The ordinary conversation header also contains a named identity's transcript tabs.
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
import { openSheet, projectsAvailable, store } from "./store.js";
import { ThreadTypeTag } from "./thread-type.js";
import { conversationLocation } from "./workspace-location.js";
import { html, Icon, shortPath, useEdge } from "./ui.js";
import { AgentTabs, tabAgent } from "./agent-tabs.js";

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

export function Topbar() {
    const { view, server, conversationId } = store.state;
    const conversation = view.conversation;
    const agent = tabAgent();
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
        class=${agent ? "topbar agent-topbar" : "topbar"}
        data-part="topbar"
        aria-description=${agent ? "On phones, scroll horizontally for chats, context and session tools." : undefined}
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
        <div class=${agent ? "title title-agent" : "title"}>
            ${
                !agent &&
                html`<button
                class="title-open"
                aria-label=${`${title}${destination ? `, ${destination}` : folder ? `, in ${folder}` : ""}: session menu`}
                title=${destination ?? (cwd ? `${shortPath(cwd, server?.home)}\nSession menu` : "Session menu")}
                disabled=${!conversation}
                onClick=${() => openSheet({ type: "menu" })}
            ></button>`
            }
            ${
                agent
                    ? html`<${AgentTabs} />`
                    : html`<span class="title-main" data-part="topbar-title" aria-hidden="true">${title}</span>`
            }
            <span class="title-sub" data-part="topbar-sub">
                ${projectsAvailable() && conversation?.kind === "session" && html`<${ThreadTypeTag} session=${conversation} />`}
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
                                  ? html`<span class="title-destination" aria-hidden=${agent ? undefined : "true"}>${destination}</span>`
                                  : folder &&
                                    html`<span class="title-folder" aria-hidden=${agent ? undefined : "true"}>${folder}</span>`
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
            class=${agent ? "icon-button topbar-menu" : "icon-button"}
            aria-label="Menu"
            title="Menu"
            aria-haspopup="dialog"
            aria-expanded=${store.state.sheet?.type === "menu"}
            onClick=${() => openSheet({ type: "menu" })}
        >
            ${
                agent &&
                html`<span class="agent-header-scroll-hint" aria-hidden="true">
                    <${Icon} name="hand-swipe" size=${16} />
                </span>`
            }
            <${Icon} name="more" />
        </button>
    </header>`;
}
