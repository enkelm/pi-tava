// The sidebar: the rail (Pi, the tools, and you; folded, numbered sessions too) and the session list beside it, in the
// sidebar, the drawer, and a phone's home screen; and the order and archiving of sessions.
import { useEffect, useLayoutEffect, useRef, useState } from "preact/hooks";
import { Avatar, folderColor, initials } from "./avatar.js";
import { goHome, useBack } from "./back.js";
import { ExtensionRailButtons } from "./extension-ui.js";
import { useDragToClose } from "./gestures.js";
import { PeeksRailButton } from "./peeks.js";
import { PipRailButton } from "./pip.js";
import { sessionForest } from "./session-tree.js";
import { PrivateList, PrivateTabs } from "./private.js";
import { projectGroups, rowsInGroups, sessionMatches } from "./project-groups.js";
import { useSessionHold } from "./session-hold.js";
import { canMoveSessions, useSessionDrag } from "./session-moves.js";
import { sessionResultUnread } from "./session-seen.js";
import { RemoteProjectIcon } from "./ssh-status.js";
import { openSidebarOptions, useSidebarContext } from "./sidebar-context.js";
import { ThreadTypeTag, threadTypeLabel } from "./thread-type.js";
import {
    organizationTargets,
    rowIsOpen,
    rowOpenId,
    workItemRows,
    WORKFLOW_LABELS,
} from "./work-items.js";
import {
    actions,
    attempt,
    canSteer,
    collab,
    handoffsAvailable,
    navigate,
    notify,
    isUnread,
    openSheet,
    projectsAvailable,
    scoped,
    sessionUnread,
    setUnread,
    stillMoving,
    store,
    workspaceOrder,
} from "./store.js";
export { workspaceOrder } from "./store.js";
import { isPinned, prefs, setPrefs, togglePin } from "./theme.js";
import {
    APPLE,
    html,
    Icon,
    railState,
    scrimPress,
    shortPath,
    Slide,
    Spinner,
    timeAgo,
    usePresence,
    useSide,
    useSlide,
} from "./ui.js";

/**
 * Back to the session list, where it is not beside the conversation: back past the sessions opened from it, as a
 * phone's back would go, or to it in this session's place when history does not lead there.
 */
export const toSessions = () => goHome(() => navigate(null, { replace: true }));

/** The session list on its way: rows shaped like sessions, lit in turn. */
function LoadingSessions() {
    return html`<div role="status" aria-label="Loading sessions">
        ${[72, 54, 64, 46, 58].map(
            (width, index) =>
                html`<div
                    class="session-placeholder"
                    aria-hidden="true"
                    style=${`--width: ${width}%; --delay: ${index * 0.12}s`}
                >
                    <span></span>
                </div>`,
        )}
    </div>`;
}

/**
 * Archive sessions, or bring them back, then say so in a notice that undoes it. Archiving the open session leaves it
 * for the home screen; undoing that opens it again.
 */
export async function setArchived(ids, archived, { undo = true } = {}) {
    if (ids.length === 0) {
        return;
    }

    const targets = organizationTargets(ids, store.state.sessions, handoffsAvailable());
    const affected = targets.flatMap((target) => target.ids);
    const titles = new Map(
        store.state.sessions.map((session) => [
            session.id,
            session.workItemTitle ?? session.title ?? "New session",
        ]),
    );

    markMoving(affected, archived);
    const results = await Promise.allSettled(
        targets.map(({ id, workItemId }) =>
            workItemId
                ? actions.updateWorkItem(id, { archived })
                : actions.updateSession(id, { archived }),
        ),
    );
    const completed = targets.filter((_, index) => results[index].status === "fulfilled");
    const done = completed.flatMap((target) => target.ids);

    // Rows that failed come back at once; the rest stay dimmed until the server's list shows them moved.
    unmarkMoving(
        affected.filter((id) => !done.includes(id)),
        archived,
    );
    const failed = results.find((result) => result.status === "rejected");

    if (failed) {
        notify("error", failed.reason?.message ?? String(failed.reason));
    }

    const open = store.state.conversationId;
    const left = undo && archived && done.includes(open);

    if (left) {
        navigate(null);
    }

    if (!undo || done.length === 0) {
        return;
    }

    const title = titles.get(completed[0].id) ?? "";
    const what =
        completed.length === 1
            ? `${completed[0].workItemId ? "Work Item " : ""}“${title.length > 48 ? `${title.slice(0, 47)}…` : title}”`
            : `${completed.length} items`;

    notify(
        "info",
        `${archived ? "Archived" : "Unarchived"} ${what}. ${matchMedia("(pointer: coarse)").matches ? "Tap" : "Click"} to undo.`,
        async () => {
            await setArchived(done, !archived, { undo: false });

            if (left && store.state.conversationId === null) {
                navigate(open);
            }
        },
    );
}

// Safari can deliver a MouseEvent click after a PointerEvent down. Keep provenance on that button,
// never on the device: an iPad may switch between touch, mouse and keyboard between openings.
const optionsPointers = new WeakMap();
const optionsPointerDown = (event) => optionsPointers.set(event.currentTarget, event.pointerType);
const optionsPointerCancel = (event) => optionsPointers.delete(event.currentTarget);

/** Button-opened Options stays beside its source on tablets, including keyboard activation. */
function optionsAt(event) {
    const rect = event.currentTarget.getBoundingClientRect();
    const pointer = event.pointerType || optionsPointers.get(event.currentTarget);

    optionsPointers.delete(event.currentTarget);

    return {
        x: rect.left,
        y: rect.bottom,
        touch:
            pointer === "touch" ||
            pointer === "pen" ||
            event.sourceCapabilities?.firesTouchEvents === true,
        keyboard: event.detail === 0,
    };
}

/** Disclosure and actions are siblings: there are no buttons inside buttons. */
function ProjectGroupHead({ group, closed, archived, needle, onToggle, canStart, trouble }) {
    const ref = useRef(null);
    const options = (at) => openSidebarOptions("project", group.project.id, at);

    useSidebarContext(ref, options, { longPress: canStart, enabled: canStart });
    const count = group.rows.length;

    return html`<div class="project-group-head" ref=${ref}>
        <button
            class="group-head"
            data-part="session-group-head"
            title=${group.label}
            onClick=${onToggle}
            aria-expanded=${!closed}
        >
            <${Icon} class="group-disclosure" name="down" size=${14} />
            <span class="group-count" data-part="session-group-count">${count}</span>
            <${RemoteProjectIcon} location=${group.project.location} />
            <span class="group-name" data-part="session-group-name"><${Highlight} text=${group.label} needle=${needle} /></span>
            ${
                trouble &&
                html`<span
                    class=${`group-trouble ${trouble}`}
                    role="img"
                    aria-label=${trouble === "waiting" ? "A session needs you" : "A session failed"}
                    title=${trouble === "waiting" ? "A session here needs you" : "A session here failed"}
                ></span>`
            }
        </button>
        <div class="project-group-actions">
            ${
                canStart &&
                store.state.me?.role === "owner" &&
                html`<button
                    class="icon-button small project-hover-action"
                    title="Edit project"
                    aria-label=${`Edit ${group.project.name}`}
                    onClick=${() => openSheet({ type: "project", projectId: group.project.id })}
                >
                    <${Icon} name="pencil" size=${14} />
                </button>`
            }
            ${
                canStart &&
                !archived &&
                html`<button
                    class="icon-button small project-hover-action"
                    title=${`New Session in ${group.project.name}`}
                    aria-label=${`New Session in ${group.project.name}`}
                    onClick=${() =>
                        openSheet({
                            type: "new-session",
                            projectId: group.project.id,
                        })}
                >
                    <${Icon} name="plus" size=${15} />
                </button>`
            }
            ${
                canStart &&
                html`<button
                    class="icon-button small sidebar-touch-options"
                    title="Options"
                    aria-label=${`Options for ${group.project.name}`}
                    aria-haspopup="menu"
                    onPointerDown=${optionsPointerDown}
                    onPointerCancel=${optionsPointerCancel}
                    onClick=${(event) => options(optionsAt(event))}
                >
                    <${Icon} name="more" size=${16} />
                </button>`
            }
        </div>
    </div>`;
}

/**
 * Mark sessions as on their way into the archive (true) or out of it (false). The store drops a mark once the list
 * shows the session where it was going; should that never happen (someone moved it straight back, or the request
 * hangs), the mark goes after a while anyway.
 */
function markMoving(ids, archived) {
    store.set((state) => ({
        moving: stillMoving(
            { ...state.moving, ...Object.fromEntries(ids.map((id) => [id, archived])) },
            state.sessions,
        ),
    }));
    setTimeout(() => unmarkMoving(ids, archived), 10_000);
}

/** Drop the marks, but not ones made since the other way (an undo, say). */
function unmarkMoving(ids, archived) {
    if (!ids.some((id) => store.state.moving[id] === archived)) {
        return;
    }

    store.set((state) => {
        const moving = { ...state.moving };

        for (const id of ids) {
            if (moving[id] === archived) {
                delete moving[id];
            }
        }

        return { moving };
    });
}

const CLOSED_KEY = "pocket.closedGroups";

const readClosed = () => {
    try {
        return new Set(JSON.parse(localStorage.getItem(CLOSED_KEY) ?? "[]"));
    } catch {
        return new Set();
    }
};

const DAY = 86_400_000;

/** Which day bucket a time falls in, in this device's time zone. */
function dayGroup(ms) {
    const today = new Date();

    today.setHours(0, 0, 0, 0);
    const start = today.getTime();

    if (ms >= start) {
        return "Today";
    }

    if (ms >= start - DAY) {
        return "Yesterday";
    }

    if (ms >= start - 6 * DAY) {
        return "This week";
    }

    if (ms >= start - 29 * DAY) {
        return "This month";
    }

    return "Earlier";
}

/** `~/Development/pi-pocket` with its last part bold, for a folder group's name. */
function FolderName({ path }) {
    const at = path.lastIndexOf("/");

    if (at <= 0) {
        return html`<b class="last">${path}</b>`;
    }

    // A long path gives way before its last part does.
    return html`<span class="first">${path.slice(0, at + 1)}</span>
        <b class="last">${path.slice(at + 1)}</b>`;
}

/** The text with what matched the search marked. */
function Highlight({ text, needle }) {
    if (!needle) {
        return text;
    }

    const at = text.toLowerCase().indexOf(needle);

    if (at === -1) {
        return text;
    }

    return html`${text.slice(0, at)}
        <mark>${text.slice(at, at + needle.length)}</mark>
        ${text.slice(at + needle.length)}`;
}

/** Failed subagents nobody has dealt with (seen or dismissed), of a session's counts or the rail's totals. */
const failing = (counts) => (counts.failed ?? 0) - (counts.dealt ?? 0);

/** "2 working · 1 failed subagents": a session's subagents, for the ⑂ mark's tooltip. */
function subagentsTip(counts) {
    const shown = { ...counts, failed: failing(counts) };
    const kinds = ["working", "waiting", "failed"].filter((kind) => shown[kind] > 0);
    const total = kinds.reduce((sum, kind) => sum + shown[kind], 0);

    return `${kinds.map((kind) => `${shown[kind]} ${kind}`).join(" · ")} subagent${total === 1 ? "" : "s"}`;
}

/** The list that opened a row's actions: Select in Options or SessionActions selects there. */
let pressedIn = null;

/**
 * Select a session in the list where its row was held, and let taps there select more (or let go), as Ctrl/⌘+click
 * does with a mouse. Used by Options and the public SessionActions sheet.
 */
export function selectFromList(id) {
    pressedIn?.current?.(id);
}

/**
 * The session's state, shared by its row and the home screen. The first that holds wins: a call waiting for you,
 * Pi or its subagents at work, a failed run (solid while new, drawn once seen), finished since this browser last
 * looked, unread people-chat or marked unread (solid), and read or never run (hollow).
 */
function stateMark(session, working, marked) {
    const fresh = marked || sessionResultUnread(session) || (collab() && sessionUnread(session));

    if (session.waiting) {
        return { shape: "waiting", label: "Waiting for approval" };
    }

    if (session.busy || working) {
        return { shape: "working", label: "Working" };
    }

    if (session.failed) {
        return fresh
            ? { shape: "failed", label: "Failed, not read" }
            : { shape: "failed seen", label: "Failed" };
    }

    return fresh
        ? { shape: "fresh", label: marked ? "Marked unread" : "Unread messages" }
        : { shape: "seen", label: "" };
}

/** A row's state for themes (`data-state`), by its square's shape: a documented name that stays when the squares change. */
const ROW_STATES = {
    waiting: "waiting",
    working: "working",
    failed: "failed",
    fresh: "done",
    seen: "idle",
};

/** A session's square, as its row in the list draws it (the home screen's Jump back in too). */
export function sessionMark(session) {
    const counts = session.subagents ?? {};

    return stateMark(
        session,
        (counts.working ?? 0) + (counts.waiting ?? 0) > 0,
        isUnread(session.id),
    );
}

/**
 * One session on one line: its folder's color in the shape of its state, its title, and on the right what goes on there (its working subagents,
 * who else is in it, Pi working, a call waiting for you), unread chat, and how long ago. Its folder and model are in
 * its tooltip.
 */
function SessionRow({
    session,
    branches = [],
    index,
    number,
    needle,
    selected,
    folders,
    onPick,
    onSelect,
    onOptions,
    dnd,
    chosen,
    member = false,
    closed,
    onToggle,
}) {
    const { conversationId, server, me } = store.state;
    const ref = useRef(null);
    const orchestrationFlight = useRef(false);
    const [orchestrationBusy, setOrchestrationBusy] = useState(false);
    const options = (at) => onOptions(session.id, at, session.members ? "work-item" : "thread");

    useSidebarContext(ref, options);
    const pinned = session.members
        ? session.members.some((member) => isPinned(member.id))
        : isPinned(session.id);

    const toggleRowPin = () => {
        if (session.members && pinned) {
            for (const member of session.members) {
                if (isPinned(member.id)) {
                    togglePin(member.id);
                }
            }
        } else {
            togglePin(session.id);
        }
    };

    const open = !session.archived && rowIsOpen(session, conversationId);
    const marked = isUnread(session.id);
    const unread = collab() && sessionUnread(session);
    const moving = store.state.moving[session.id] !== undefined;
    const canDrag = !member && canMoveSessions() && !moving && !dnd.busy;
    const { hold, consumeClick } = useSessionHold({
        ref,
        enabled: !moving && !dnd.busy,
        canDrag,
        onOptions: options,
        onDragStart: (point) => dnd.startTouch(point, session.id, chosen),
        onDragMove: (point) => dnd.moveTouch(point),
        onDragEnd: (point) => dnd.endTouch(point),
        onDragCancel: () => dnd.cancelTouch(),
    });
    const title = session.title ?? "New session";
    const orchestratable = session.members && me?.role === "owner" && !session.archived;
    const supervisor = me?.role === "owner" ? session.supervisor : undefined;
    const supervising = supervisor?.status === "running";
    const orchestrationLabel = `Open PiP Thread for ${title}`;
    const workStatus = me?.role === "owner"
        ? html`<span
              class="work-item-pip-state"
              data-status=${supervising ? "running" : "reclaimed"}
              role="img"
              aria-label=${supervising ? "PiP active" : "Human control"}
              title=${supervising ? "PiP active" : "Human control"}
          >
              <${Icon} name="pip" size=${12} />
          </span>`
        : (WORKFLOW_LABELS[session.workflow?.status] ?? "Active");
    // Every top-level thread has working context, even without a Coop-created worktree or handoff.
    const details = !member;
    const path = shortPath(session.cwd, server?.home);
    const reference =
        session.branch?.branch ??
        (session.branch?.detached && `${session.branch.detached} (detached)`);
    const where = [reference ? `${path} ⎇ ${reference}` : path, session.model].filter(Boolean);
    // The Folders tab names the folder above the row already: its model comes first.
    const tip = [title, ...(folders ? where.reverse() : where)].join(" · ");
    // A search can match the folder or model instead of the title: the row shows which.
    let hit =
        needle && !title.toLowerCase().includes(needle)
            ? [path, session.cwd, session.model].find((text) =>
                  text?.toLowerCase().includes(needle),
              )
            : undefined;

    // A path from the folder that matched: its start is the same in every row, and would push the match out of sight.
    if (hit && hit !== session.model) {
        const parts = hit.split("/");
        const at = parts.findLastIndex((part) => part.toLowerCase().includes(needle));

        hit = at > 0 ? `…/${parts.slice(at).join("/")}` : hit;
    }

    const counts = session.subagents ?? {};
    const live = (counts.working ?? 0) + (counts.waiting ?? 0);
    const failed = failing(counts);
    // Subagents at work, or failed ones nobody dealt with, but not over a call waiting for you: that says more.
    const fork = !session.waiting && (live > 0 || failed > 0);
    const person = collab() ? (session.people ?? []).find((each) => each.id !== me?.id) : undefined;
    const mark = stateMark(session, live > 0, marked);
    // Finished since this browser last looked: its result is unread, so its title reads bold.
    const unseen = sessionResultUnread(session);
    // Options joins the existing archive, pin and mark-unread hover actions.
    const acts = (!member && canSteer() ? 1 : 0) + (session.archived ? 0 : 2) + 1;
    const state = html`<span class="session-mark">
        ${
            selected
                ? html`<span class="state-check" role="img" aria-label="Selected">
                      <${Icon} name="check" size=${9} />
                  </span>`
                : mark.shape === "working"
                  ? html`<span data-part="session-mark"><${Spinner} /></span>`
                  : html`<span
                        class=${
                            mark.shape === "fresh" || mark.shape === "seen"
                                ? `state-idle ${mark.shape === "fresh" ? "unread pulse" : ""}`
                                : `state-mark ${mark.shape} ${mark.shape === "failed" ? "pulse" : ""}`
                        }
                        data-part="session-mark"
                        style=${`--folder:${folderColor(session.cwd)}`}
                        role=${mark.label ? "img" : undefined}
                        aria-label=${mark.label || undefined}
                        aria-hidden=${mark.label ? undefined : "true"}
                        title=${mark.label || undefined}
                    ></span>`
        }
    </span>`;
    const name = html`<span class=${`session-title ${hit ? "with-hit" : ""}`}>
        ${
            hit
                ? html`<span class="session-name">${title}</span>
                      <span class="session-hit">
                          <${Highlight} text=${hit} needle=${needle} />
                      </span>`
                : html`<${Highlight} text=${title} needle=${needle} />`
        }
    </span>`;
    const disclosureLabel = `${closed ? "Expand" : "Collapse"} Work Item ${session.title} · ${threadTypeLabel(session)}`;

    return html`<div
        class=${`session-row ${details ? "with-details" : ""} ${session.members ? "work-item-head" : ""} ${member ? "work-item-member" : ""} ${open ? "active" : ""} ${selected ? "selected" : ""} ${hold ? "pressing" : ""} ${moving ? "moving" : ""} ${dnd.drag?.ids.includes(session.id) ? "dragging" : ""} ${marked ? "marked-unread" : ""} ${unseen ? "unseen" : ""} ${["no-acts", "one-act", "", "three-acts", "four-acts"][acts]}`}
        ref=${ref}
        data-part="session-row"
        data-state=${ROW_STATES[mark.shape.split(" ")[0]]}
        data-id=${session.id}
        style=${`--i:${index};--linked-depth:${Math.min(branches.length, 3)}`}
    >
        ${
            branches.length > 0 &&
            html`<span class="session-branches" data-part="session-branches" aria-hidden="true">
                ${branches.slice(-3).map(
                    (continues, index, visible) =>
                        html`<span
                                class=${`${continues ? "continues" : ""} ${index === visible.length - 1 ? "elbow" : ""}`}
                            ></span>`,
                )}
            </span>`
        }
        ${
            session.members &&
            html`<button
                class="work-item-disclosure icon-button"
                data-session-hold-action="true"
                aria-label=${disclosureLabel}
                title=${disclosureLabel}
                aria-expanded=${!closed}
                onClick=${onToggle}
            >
                <${ThreadTypeTag} session=${session} iconOnly=${true} />
                <${Icon} class="work-item-chevron" name=${closed ? "chevron" : "down"} size=${12} />
            </button>`
        }
        <button
            class=${`session ${unread ? "unread" : ""}`}
            data-part="session-button"
            aria-current=${open ? "page" : undefined}
            draggable=${canDrag && !matchMedia("(pointer: coarse)").matches}
            onDragStart=${(event) => dnd.start(event, session.id, chosen)}
            onPointerDown=${(event) => onSelect(event, session.id)}
            onClick=${(event) => !consumeClick(event) && onPick(event, session.id)}
            aria-haspopup="menu"
            title=${tip}
        >
            ${
                !session.members &&
                (member || projectsAvailable()
                    ? html`<span class="session-state"><${ThreadTypeTag} session=${session} iconOnly=${true} /></span>`
                    : state)
            }
            ${
                details
                    ? html`<span class="session-main">
                        ${name}
                        <span class="session-meta">
                            ${
                                session.members &&
                                html`<span class="work-item-status">
                                    ${workStatus} · ${session.members.length} threads
                                </span>`
                            }
                            <span class="mono"><${Highlight} text=${path} needle=${needle} /></span>
                            ${
                                reference
                                    ? html`<span class="mono">
                                        <${Icon} name="branch" size=${10} /> ${reference}
                                    </span>`
                                    : session.model &&
                                      html`<span class="mono">${session.model}</span>`
                            }
                        </span>
                    </span>`
                    : name
            }
            <span class="session-side">
                ${
                    fork &&
                    html`<span
                        class=${`session-fork ${live > 0 ? "" : "failed"}`}
                        title=${subagentsTip(counts)}
                    >
                        <${Icon} name="fork" size=${10} />${live > 0 ? live : failed}
                    </span>`
                }
                ${!fork && person && html`<${Avatar} person=${person} size=${18} />`}
                ${(session.members || member || projectsAvailable()) && state}
                ${
                    session.waiting &&
                    html`<span class="session-needs" title="Waiting for approval">
                        ${canSteer() ? "needs you" : "waiting"}
                    </span>`
                }
                <span class="session-time">${timeAgo(session.updatedAt)}</span>
                ${
                    number !== undefined &&
                    number < 9 &&
                    html`<kbd class="session-num">${number + 1}</kbd>`
                }
            </span>
        </button>
        <span class="session-actions">
            <button
                class=${`session-act session-options ${session.members ? "work-item-options" : ""}`}
                data-session-hold-action="true"
                title=${session.members ? "Work Item options" : "Options"}
                aria-label=${session.members ? "Work Item options" : `Options for ${session.title ?? "New session"}`}
                aria-haspopup="menu"
                disabled=${moving}
                onPointerDown=${optionsPointerDown}
                onPointerCancel=${optionsPointerCancel}
                onClick=${(event) => options(optionsAt(event))}
            >
                <${Icon} name="settings" size=${16} />
            </button>
            ${
                !member &&
                canSteer() &&
                html`<button
                    class="session-act"
                    data-session-hold-action="true"
                    title=${session.archived ? "Unarchive" : "Archive"}
                    aria-label=${session.members ? (session.archived ? "Restore Work Item" : "Archive Work Item") : session.archived ? "Unarchive" : "Archive"}
                    onClick=${() => setArchived([session.id], !session.archived)}
                >
                    <${Icon} name=${session.archived ? "unarchive" : "archive"} size=${14} />
                </button>`
            }
            ${
                !session.archived &&
                html`<button
                    class=${`session-act session-pin ${pinned ? "on" : ""}`}
                    data-session-hold-action="true"
                    title=${pinned ? "Unpin" : "Pin to the top"}
                    aria-label=${pinned ? "Unpin" : "Pin"}
                    onClick=${toggleRowPin}
                >
                    <${Icon} name="pin" size=${14} />
                </button>`
            }
            ${
                orchestratable
                    ? html`<button
                        class="session-act session-orchestrate"
                        data-session-hold-action="true"
                        title=${orchestrationLabel}
                        aria-label=${orchestrationLabel}
                        aria-description=${supervising ? "PiP active" : "Human control"}
                        disabled=${moving || orchestrationBusy}
                        onClick=${() => {
                            const current = store.state;
                            const source = current.sessions.find((each) => each.id === session.id);

                            if (
                                orchestrationFlight.current ||
                                current.me?.role !== "owner" ||
                                current.me.id !== me.id ||
                                source?.workItemId !== session.workItemId ||
                                source?.archived
                            ) {
                                return;
                            }

                            orchestrationFlight.current = true;
                            setOrchestrationBusy(true);

                            return attempt(async () => {
                                try {
                                    await actions.openWorkPip(session.id);
                                } finally {
                                    orchestrationFlight.current = false;
                                    setOrchestrationBusy(false);
                                }
                            });
                        }}
                    >
                        <${Icon} name="pip" size=${16} />
                    </button>`
                    : !session.archived &&
                      html`<button
                          class=${`session-act session-unread ${marked ? "on" : ""}`}
                          data-session-hold-action="true"
                          title=${marked ? "Mark read" : "Mark unread"}
                          aria-label=${marked ? "Mark read" : "Mark unread"}
                          onClick=${() => setUnread(session.id, !marked)}
                      >
                          <${Icon} name=${marked ? "check" : "unread"} size=${14} />
                      </button>`
            }
        </span>
        ${
            hold &&
            html`<div
                class="session-hold"
                data-choice=${hold.choice ?? undefined}
                data-phase=${hold.phase}
                style=${`--hold-expand:${hold.expandMs}ms;--hold-fill:${hold.fillMs}ms`}
                role="group"
                aria-label="Slide to Drag or Options, then hold"
            >
                <button
                    class=${`session-hold-choice drag ${hold.choice === "drag" ? "selected" : ""}`}
                    data-session-hold-action="true"
                    disabled=${!canDrag}
                    onClick=${() => openSheet({ type: "move-sessions", ids: [session.id] })}
                >
                    <span class="session-hold-label">
                        <${Icon} name="hand-swipe" size=${20} />
                        Drag
                    </span>
                </button>
                <button
                    class=${`session-hold-choice options ${hold.choice === "options" ? "selected" : ""}`}
                    data-session-hold-action="true"
                    onPointerDown=${optionsPointerDown}
                    onPointerCancel=${optionsPointerCancel}
                    onClick=${(event) => options(optionsAt(event))}
                >
                    <span class="session-hold-label">
                        <${Icon} name="settings" size=${20} />
                        Options
                    </span>
                </button>
            </div>`
        }
    </div>`;
}

function WorkItemRow({ session, closed, onToggle, ...rowProps }) {
    const linked = sessionForest(session.members);
    // Keep admission order between independent threads, while retaining each linked family exactly once.
    const members = session.members.flatMap((member) => linked.rows.get(member.id) ?? []);

    return html`<section
        class=${`work-item ${closed ? "closed" : ""}`}
        data-work-item-id=${session.workItemId}
        aria-label=${`Work Item ${session.title}`}
    >
        <${SessionRow} session=${session} closed=${closed} onToggle=${onToggle} ...${rowProps} />
        <div class="group-body work-item-body" inert=${closed}>
            <div>
                ${members.map(
                    ({ session: member, branches }) => html`<${SessionRow}
                    ...${rowProps}
                    key=${member.id}
                    session=${member}
                    branches=${branches}
                    member=${true}
                    number=${undefined}
                    selected=${false}
                    onSelect=${() => {}}
                    onPick=${(event, id) => {
                        if (rowProps.dnd.consumeClick(event)) {
                            return;
                        }

                        event.preventDefault();
                        navigate(id);
                    }}
                />`,
                )}
            </div>
        </div>
    </section>`;
}

/** Sessions in groups: pinned, then by day or by folder. While searching, one flat list of matches. */
function groupsOf(shown, { tab, needle, home, pinned }) {
    if (needle !== "" || tab === "archived") {
        return [{ key: "flat", label: needle ? "Matches" : "Archived", rows: shown }];
    }

    const groups = [];
    const rowPinned = (session) =>
        pinned.includes(session.id) ||
        session.members?.some((member) => pinned.includes(member.id));
    const pins = shown.filter(rowPinned);

    if (pins.length > 0) {
        groups.push({ key: "pinned", label: "Pinned", rows: pins });
    }

    const rest = shown.filter((session) => !rowPinned(session));
    const byKey = new Map();

    for (const session of rest) {
        const key = tab === "folders" ? `dir:${session.cwd}` : `day:${dayGroup(session.updatedAt)}`;

        if (!byKey.has(key)) {
            byKey.set(key, {
                key,
                label:
                    tab === "folders"
                        ? html`<${FolderName} path=${shortPath(session.cwd, home)} />`
                        : dayGroup(session.updatedAt),
                rows: [],
            });
        }

        byKey.get(key).rows.push(session);
    }

    return [...groups, ...byKey.values()];
}

const PROJECT_TABS = [
    ["projects", "Projects"],
    ["recent", "Recent"],
    ["archived", "Archived"],
];

const TABS = [
    ["recent", "Recent"],
    ["folders", "Folders"],
    ["archived", "Archived"],
];

/**
 * What the full list searched for and how far it was scrolled, kept while the tab lives: on a phone the list goes when a
 * session opens, and back from the session shows it again as it was.
 */
const listKept = { query: "", scroll: 0 };

export function SessionList({ compact = false, home = false }) {
    const { sessions, sessionsLoaded, server, me, pinned, projects, projectsLoaded } = store.state;
    const organized = projectsAvailable();
    const tabChoices = organized ? PROJECT_TABS : TABS;
    const privateTab = me?.role === "owner" && store.state.sidebarTab === "private";
    const canStart = canSteer() && !scoped();
    const [query, setQueryState] = useState(() => (compact ? "" : listKept.query));
    const [tab, setTabState] = useState(() =>
        organized
            ? (prefs().projectGroup ?? "projects")
            : prefs().group === "folder"
              ? "folders"
              : "recent",
    );

    useEffect(() => {
        setTabState(
            organized
                ? (prefs().projectGroup ?? "projects")
                : prefs().group === "folder"
                  ? "folders"
                  : "recent",
        );
    }, [organized]);
    const [closed, setClosed] = useState(readClosed);
    const [searchClosed, setSearchClosed] = useState(() => new Set());
    const [selected, setSelectedState] = useState(() => new Set());
    // Taps select rows instead of opening them after Select in a row's action sheet.
    const [tapSelects, setTapSelects] = useState(false);
    // The selection as drags and clicks see it between renders; the row a Shift+click extends from; the row a Ctrl/⌘ press
    // already selected, whose click then does nothing; the rows in view, in order.
    const picked = useRef(selected);
    const anchor = useRef(null);
    const held = useRef(null);
    const visible = useRef([]);
    const list = useRef(null);
    const tabs = useRef(null);
    const needle = query.trim().toLowerCase();
    const archived = tab === "archived";

    const setQuery = (next) => {
        if (!compact) {
            listKept.query = next;
        }

        setQueryState(next);
        setSearchClosed(new Set());
    };

    // Scrolled back to where it was, once its rows are there.
    useLayoutEffect(() => {
        if (!compact && sessionsLoaded && list.current) {
            list.current.scrollTop = listKept.scroll;
        }
    }, [sessionsLoaded]);

    const setSelected = (next) => {
        picked.current = next;
        setSelectedState(next);

        if (next.size === 0) {
            setTapSelects(false);
        }
    };

    // What Select in this list's Options or legacy held-row sheet does here.
    const startSelect = useRef(null);

    startSelect.current = (id) => {
        // Member Options selects the visible Work Item, never a hidden duplicate child row.
        const row = shown.find(
            (each) => each.id === id || each.members?.some((member) => member.id === id),
        );

        if (!row) {
            return;
        }

        anchor.current = row.id;
        setSelected(new Set([...picked.current, row.id]));
        setTapSelects(true);
    };

    useEffect(
        () => () => {
            if (pressedIn === startSelect) {
                pressedIn = null;
            }
        },
        [],
    );

    const openThreadOptions = (id, at, kind = "thread") => {
        pressedIn = startSelect;
        openSidebarOptions(kind, id, at, { keepDrawer: true });
    };

    const clearSelection = () => {
        anchor.current = null;
        setSelected(new Set());
    };

    const setTab = (next) => {
        setTabState(next);
        clearSelection();

        if (next !== "archived") {
            setPrefs(
                organized
                    ? { projectGroup: next }
                    : { group: next === "folders" ? "folder" : "recent" },
            );
        }
    };

    const hierarchical = organized && (tab === "projects" || archived);
    const sidebarRows = workItemRows(sessions, handoffsAvailable());
    const matching = sidebarRows.filter(
        (session) =>
            Boolean(session.archived) === archived &&
            sessionMatches(session, needle, {
                home: server?.home,
                project: organized ? projects.find((each) => each.id === session.projectId) : null,
            }),
    );
    const rowPins = [
        ...new Set(
            pinned
                .map(
                    (id) =>
                        sidebarRows.find(
                            (row) =>
                                row.id === id || row.members?.some((member) => member.id === id),
                        )?.id,
                )
                .filter((id) => id !== undefined),
        ),
    ];
    const forest = sessionForest(matching, { pinned: rowPins, folders: tab === "folders" });
    const rawGroups = hierarchical
        ? projectGroups(sidebarRows, projects, {
              archived,
              needle,
              pinned,
              home: server?.home,
          })
        : groupsOf(forest.roots, { tab, needle, home: server?.home, pinned });

    // Linked sessions remain independent placements: only nest families inside the same project.
    // Keep raw session rows for project counts/moves, alongside their branch guides for rendering.
    const linkGroup = (group) => {
        const linked = hierarchical ? sessionForest(group.rows, { pinned: rowPins }) : forest;
        let roots = hierarchical ? linked.roots : group.rows;

        if (hierarchical && group.key === "flat") {
            const pins = rowPins
                .map((id) => roots.find((session) => session.id === id))
                .filter(Boolean);

            roots = [...pins, ...roots.filter((session) => !pins.includes(session))];
        }

        const linkedRows = roots.flatMap((session) => linked.rows.get(session.id));

        return {
            ...group,
            rows: linkedRows.map((row) => row.session),
            linkedRows,
        };
    };

    const groups = rawGroups.map(linkGroup);
    const shown = rowsInGroups(groups);
    const groupClosed = (group) =>
        (needle ? searchClosed : closed).has(group.key) && group.key !== "flat";

    visible.current = rowsInGroups(groups, groupClosed).map((session) => session.id);
    const chosen = privateTab
        ? []
        : shown.filter((session) => selected.has(session.id)).map((session) => session.id);
    // Taps select while the bar shows: not for rows selected and then hidden (archived, or searched away).
    const tapping = tapSelects && chosen.length > 0;
    const numbers = new Map(workspaceOrder().map((session, index) => [session.id, index]));
    const dnd = useSessionDrag({
        enabled: organized && canStart && !privateTab,
        list,
        selected: picked,
        onMoved: (ids) =>
            setSelected(new Set([...picked.current].filter((id) => !ids.includes(id)))),
    });
    const unassigned = { key: "unassigned", projectId: null, label: "No project" };

    /** The rows from `from` to `to` as they show, or just `to` when either is out of view. */
    const span = (from, to) => {
        const ids = visible.current;
        const a = ids.indexOf(from);
        const b = ids.indexOf(to);

        return a === -1 || b === -1 ? [to] : ids.slice(Math.min(a, b), Math.max(a, b) + 1);
    };

    /**
     * A plain click opens the session. Shift+click selects from the last row picked (or the open one) to this row;
     * Ctrl/⌘+Enter on a focused row selects it or lets it go.
     */
    const pick = (event, id) => {
        if (dnd.consumeClick(event)) {
            return;
        }

        // The press already selected, even if Ctrl/⌘ was let go before the button.
        if (held.current === id && event.detail > 0) {
            held.current = null;

            return;
        }

        if (event.shiftKey) {
            // From the last row picked, or else the open session, if it shows; or else from this row on.
            if (!visible.current.includes(anchor.current)) {
                const open = store.state.conversationId;

                anchor.current = visible.current.includes(open) ? open : id;
            }

            setSelected(new Set([...picked.current, ...span(anchor.current, id)]));

            return;
        }

        if (event.ctrlKey || event.metaKey || tapping) {
            const next = new Set(picked.current);

            if (next.has(id)) {
                next.delete(id);
            } else {
                next.add(id);
            }

            anchor.current = id;
            setSelected(next);

            return;
        }

        clearSelection();
        navigate(rowOpenId(shown.find((row) => row.id === id)) ?? id);
    };

    /**
     * Ctrl/⌘+press on a row selects it (or, if it was selected, unselects it); dragging on does the same to every row
     * between it and the pointer. Once the pointer moves, the list scrolls along near its top or bottom edge. Touch
     * hold/slide intent is handled independently by useSessionHold.
     */
    const select = (event, id) => {
        held.current = null;

        if (event.button !== 0) {
            return;
        }

        if (event.pointerType !== "mouse") {
            // Touch intent belongs to useSessionHold, not a second pointer-hold timer.
            return;
        }

        if (event.shiftKey) {
            // No text selection: the click extends the session selection instead.
            event.preventDefault();

            return;
        }

        if (!event.ctrlKey && !event.metaKey) {
            return;
        }

        event.preventDefault();
        held.current = id;
        const box = list.current;
        const root = document.documentElement;
        const before = picked.current;
        const adding = !before.has(id);

        anchor.current = id;
        let reached = null;

        const reach = (to) => {
            if (to === reached) {
                return;
            }

            reached = to;
            const next = new Set(before);

            for (const each of span(id, to)) {
                if (adding) {
                    next.add(each);
                } else {
                    next.delete(each);
                }
            }

            setSelected(next);
        };

        reach(id);
        const start = event.clientY;
        let y = start;

        // The row at the pointer's height, held inside the list so a drag past its sides or ends still counts.
        const under = () => {
            const rect = box.getBoundingClientRect();
            const row = document
                .elementFromPoint(
                    rect.left + box.clientWidth / 2,
                    Math.min(rect.bottom - 2, Math.max(rect.top + 2, y)),
                )
                ?.closest?.(".session-row[data-id]");

            if (!row || !box.contains(row)) {
                return;
            }

            const found = visible.current.find((each) => String(each) === row.dataset.id);

            if (found !== undefined) {
                reach(found);
            }
        };

        // No frame until the pointer moves: a press near an edge is not a drag.
        let frame = 0;

        const scroll = () => {
            const rect = box.getBoundingClientRect();
            const edge = 36;
            const past =
                y < rect.top + edge
                    ? y - rect.top - edge
                    : y > rect.bottom - edge
                      ? y - rect.bottom + edge
                      : 0;

            if (past !== 0) {
                box.scrollTop += Math.max(-24, Math.min(24, past / 2));
                under();
            }

            frame = requestAnimationFrame(scroll);
        };

        const move = (each) => {
            // The button came up where this page did not hear it, say in another window.
            if ((each.buttons & 1) === 0) {
                return stop();
            }

            y = each.clientY;

            if (frame === 0 && Math.abs(y - start) > 4) {
                frame = requestAnimationFrame(scroll);
            }

            under();
        };

        const stop = () => {
            cancelAnimationFrame(frame);
            root.classList.remove("selecting");
            removeEventListener("pointermove", move);
            removeEventListener("pointerup", stop);
            removeEventListener("pointercancel", stop);
            removeEventListener("blur", stop);
        };

        root.classList.add("selecting");
        getSelection()?.removeAllRanges();
        addEventListener("pointermove", move);
        addEventListener("pointerup", stop);
        addEventListener("pointercancel", stop);
        addEventListener("blur", stop);
    };

    const archiveChosen = () => {
        clearSelection();
        setArchived(chosen, !archived);
    };

    const busy = sessions.filter((session) => session.busy).length;
    const pinRows = shown.filter((row) => chosen.includes(row.id));
    const allPinned =
        pinRows.length > 0 &&
        pinRows.every(
            (row) =>
                pinned.includes(row.id) ||
                row.members?.some((member) => pinned.includes(member.id)),
        );

    const pinChosen = () => {
        for (const row of pinRows) {
            const ids = allPinned ? (row.members ?? [row]).map((member) => member.id) : [row.id];

            for (const id of ids) {
                if (isPinned(id) === allPinned) {
                    togglePin(id);
                }
            }
        }

        clearSelection();
    };

    // Esc lets go of the selection, unless something else takes it: a sheet, the launcher, a text field, or a menu.
    const selecting = selected.size > 0;

    // On a touch screen, so does back.
    useBack(tapping, clearSelection);

    useEffect(() => {
        if (!selecting) {
            return;
        }

        const onKey = (event) => {
            if (
                event.key !== "Escape" ||
                event.defaultPrevented ||
                store.state.sheet ||
                store.state.launcher
            ) {
                return;
            }

            // Taken: this Esc lets go of the selection, and closes nothing else.
            event.preventDefault();
            clearSelection();
        };

        addEventListener("keydown", onKey);

        return () => removeEventListener("keydown", onKey);
    }, [selecting]);

    const toggleGroup = (key) => {
        const next = new Set(needle ? searchClosed : closed);

        if (next.has(key)) {
            next.delete(key);
        } else {
            next.add(key);
        }

        if (needle) {
            setSearchClosed(next);
        } else {
            localStorage.setItem(CLOSED_KEY, JSON.stringify([...next]));
            setClosed(next);
        }
    };

    const tabBar = useSlide(tabs, "button.on", "x");
    let index = 0;

    const renderGroup = (group) => {
        const isClosed = groupClosed(group);
        const trouble = isClosed
            ? group.rows
                  .map((session) => sessionMark(session).shape)
                  .find((shape) => shape === "waiting" || shape === "failed")
            : undefined;
        const destination = group.project
            ? {
                  key: group.key,
                  projectId: group.project.id,
                  label: group.project.name,
              }
            : null;
        const dropTarget = destination && dnd.drag?.target?.key === group.key;
        const groupClass = [
            "session-group",
            group.project && "project-section",
            isClosed && "closed",
            dropTarget && "drop-target",
        ]
            .filter(Boolean)
            .join(" ");

        return html`<section
            class=${groupClass}
            data-part="session-group"
            key=${`${tab}:${group.key}`}
            data-project-id=${group.project?.id}
            data-session-drop=${destination ? JSON.stringify(destination) : undefined}
            data-session-drop-closed=${isClosed ? "true" : undefined}
            onDragOver=${
                destination
                    ? (event) =>
                          dnd.over(
                              event,
                              destination,
                              isClosed ? () => toggleGroup(group.key) : null,
                          )
                    : undefined
            }
            onDragLeave=${destination ? dnd.leave : undefined}
            onDrop=${destination ? (event) => dnd.drop(event, destination) : undefined}
        >
            ${
                group.project
                    ? html`<${ProjectGroupHead}
                    group=${group}
                    closed=${isClosed}
                    archived=${archived}
                    needle=${needle}
                    onToggle=${() => toggleGroup(group.key)}
                    canStart=${canStart}
                    trouble=${trouble}
                />`
                    : (group.key !== "flat" || (needle && !hierarchical)) &&
                      html`<button
                    class="group-head"
                    data-part="session-group-head"
                    onClick=${() => group.key !== "flat" && toggleGroup(group.key)}
                    aria-expanded=${!isClosed}
                >
                    <span class="group-name" data-part="session-group-name">
                        ${typeof group.label === "string" ? html`<b>${group.label}</b>` : group.label}
                    </span>
                    ${
                        trouble &&
                        html`<span
                        class=${`group-trouble ${trouble}`}
                        role="img"
                        aria-label=${trouble === "waiting" ? "A session needs you" : "A session failed"}
                        title=${trouble === "waiting" ? "A session here needs you" : "A session here failed"}
                    ></span>`
                    }
                    <span class="group-count" data-part="session-group-count">${group.rows.length}</span>
                    ${group.key !== "flat" && html`<${Icon} name="down" size=${12} />`}
                </button>`
            }
            <div class="group-body" inert=${isClosed}>
                <div>
                    ${group.linkedRows.map(
                        ({
                            session,
                            branches,
                        }) => html`<${session.members ? WorkItemRow : SessionRow}
                        key=${session.workItemId ?? session.id}
                        session=${session}
                        closed=${groupClosed({ key: `work:${session.workItemId}` })}
                        onToggle=${() => toggleGroup(`work:${session.workItemId}`)}
                        branches=${branches}
                        folders=${tab === "folders" && needle === ""}
                        index=${index++}
                        number=${numbers.get(session.id)}
                        needle=${needle}
                        selected=${selected.has(session.id)}
                        onPick=${pick}
                        onSelect=${select}
                        onOptions=${openThreadOptions}
                        dnd=${dnd}
                        chosen=${chosen}
                    />`,
                    )}
                    ${group.project && group.rows.length === 0 && html`<div class="project-empty muted small">No threads yet.</div>`}
                </div>
            </div>
        </section>`;
    };

    return html`<div class=${`sessions ${compact ? "compact" : ""}`} data-part="session-list">
        <div class="sessions-head">
            <span class="brand">π <span>Pocket</span></span>
            <button
                class="icon-button"
                title="Launcher"
                aria-label="Open the launcher"
                onClick=${() => store.set({ launcher: true, drawer: false })}
            >
                <${Icon} name="command" size=${18} />
            </button>
            ${
                !compact &&
                html`<button
                    class="icon-button sidebar-fold"
                    title="Fold the sidebar"
                    aria-label="Fold the sidebar"
                    onClick=${() => setPrefs({ sidebar: "rail" })}
                >
                    <${Icon} name="sidebar" size=${18} />
                </button>`
            }
        </div>
        <${PrivateTabs} />
        ${
            privateTab
                ? html`<${PrivateList} compact=${compact} home=${home} />`
                : html`
                      <label class=${`search ${query ? "filled" : ""}`} data-part="session-search">
                          <${Icon} name="search" size=${14} />
                          <input
                              placeholder=${organized ? "Search sessions, projects" : "Search sessions"}
                              aria-label=${organized ? "Search sessions, projects" : "Search sessions"}
                              value=${query}
                              onInput=${(event) => setQuery(event.currentTarget.value)}
                              onKeyDown=${(event) => {
                                  if (event.key !== "Escape" || query === "") {
                                      return;
                                  }

                                  // Taken: this Esc clears the search, not the selection.
                                  event.preventDefault();
                                  setQuery("");
                              }}
                          />
                          ${
                              query
                                  ? html`<button
                                        class="search-clear"
                                        aria-label="Clear"
                                        onClick=${() => setQuery("")}
                                    >
                                        <${Icon} name="close" size=${13} />
                                    </button>`
                                  : html`<span
                                            class="search-keys"
                                            title="Launcher"
                                            aria-hidden="true"
                                            onClick=${(event) => {
                                                event.preventDefault();
                                                store.set({ launcher: true, drawer: false });
                                            }}
                                        >
                                            ${APPLE ? "⌘K" : "Ctrl K"}
                                        </span>
                                        <button
                                            class="search-launcher"
                                            title="Launcher"
                                            aria-label="Open the launcher"
                                            onClick=${(event) => {
                                                event.preventDefault();
                                                store.set({ launcher: true, drawer: false });
                                            }}
                                        >
                                            <${Icon} name="command" size=${14} />
                                        </button>`
                          }
                      </label>
                      ${
                          canStart &&
                          html`<button
                              class="button primary wide new-button"
                              aria-label="New session"
                              onClick=${() => openSheet({ type: "new-session" })}
                          >
                              <${Icon} name="plus" size=${16} /> New Session
                          </button>`
                      }
                      <div class="session-tabs" data-part="session-tabs" role="tablist" ref=${tabs}>
                          ${tabChoices.map(
                              ([key, label]) =>
                                  html`<button
                                      role="tab"
                                      aria-selected=${tab === key}
                                      class=${tab === key ? "on" : ""}
                                      onClick=${() => setTab(key)}
                                      onDragOver=${key === "projects" && tab !== "projects" ? (event) => dnd.hoverProjects(event, () => setTab("projects")) : undefined}
                                      data-session-projects-tab=${key === "projects" ? "true" : undefined}
                                      onDragLeave=${key === "projects" ? dnd.leaveProjects : undefined}
                                  >
                                      ${label}
                                  </button>`,
                          )}
                          <${Slide} box=${tabBar} axis="x" />
                      </div>
                      <div
                          class="session-items"
                          key="session-items"
                          onDragOverCapture=${dnd.scroll}
                          onDragLeaveCapture=${dnd.leaveList}
                          ref=${list}
                          onScroll=${(event) => !compact && (listKept.scroll = event.currentTarget.scrollTop)}
                      >
                          ${!sessionsLoaded && html`<${LoadingSessions} />`}
                          ${
                              sessionsLoaded &&
                              (!hierarchical || projectsLoaded) &&
                              shown.length === 0 &&
                              !groups.some((group) => group.project) &&
                              html`<div class="sessions-empty">
                                  ${archived ? "No archived sessions." : needle ? "No matches." : "No sessions yet. Start one with New Session."}
                              </div>`
                          }
                          ${hierarchical && !projectsLoaded && html`<div class="muted pad" role="status">Loading projects…</div>`}
                          ${groups.map(renderGroup)}
                          <div class="session-drag-tools" key="drag-tools" hidden=${!dnd.drag}>
                              ${
                                  dnd.drag &&
                                  html`<p class="session-drag-status small" role="status">
                                      ${
                                          dnd.drag.target
                                              ? `Move to ${dnd.drag.target.label}`
                                              : `Drag ${dnd.drag.ids.length === 1 ? "session" : `${dnd.drag.ids.length} sessions`} to a project`
                                      }
                                  </p>
                                  <div
                                      class=${`session-drop-unassigned ${dnd.drag.target?.key === unassigned.key ? "drop-target" : ""}`}
                                      data-session-drop=${JSON.stringify(unassigned)}
                                      onDragOver=${(event) => dnd.over(event, unassigned)}
                                      onDragLeave=${dnd.leave}
                                      onDrop=${(event) => dnd.drop(event, unassigned)}
                                  >
                                      <${Icon} name="folder" size=${14} /> No project
                                  </div>`
                              }
                          </div>
                      </div>
                  `
        }
        <div class="sessions-foot">
            <div class="foot-top">
                <div class=${`foot-tiles ${chosen.length > 0 ? "covered" : ""}`}>
                    <button
                        class=${`foot-tile ${busy > 0 ? "lit" : ""}`}
                        title="Everything Pi is doing"
                        onClick=${() => openSheet({ type: "running" })}
                    >
                        <${Icon} name="pulse" size=${16} />
                        Running${busy > 0 && html`<span class="tile-count">${busy}</span>`}
                    </button>
                    ${
                        collab()
                            ? html`<button
                                  class="foot-tile"
                                  title=${canStart ? "People and invites" : "People"}
                                  onClick=${() => openSheet({ type: "settings", tab: "account" })}
                              >
                                  <${Icon} name="users" size=${16} /> People
                              </button>`
                            : html`<button
                                  class="foot-tile"
                                  title="Sign in another device"
                                  onClick=${() => openSheet({ type: "settings", tab: "account" })}
                              >
                                  <${Icon} name="users" size=${16} /> Devices
                              </button>`
                    }
                    <button
                        class="foot-tile"
                        title="Appearance and model providers"
                        onClick=${() => openSheet({ type: "settings" })}
                    >
                        <${Icon} name="settings" size=${16} /> Settings
                    </button>
                </div>
                ${
                    chosen.length > 0 &&
                    html`<div class="select-bar" role="group" aria-label="Selected sessions">
                        <span class="select-count">
                            <b>${chosen.length}</b>
                            <span class="select-word"> selected</span>
                        </span>
                        ${
                            canMoveSessions() &&
                            html`<button
                                class="button small"
                                disabled=${dnd.busy}
                                onClick=${() => openSheet({ type: "move-sessions", ids: chosen })}
                            >
                                Move…
                            </button>`
                        }
                        ${
                            canSteer() &&
                            html`<button class="button small" onClick=${archiveChosen}>
                                ${archived ? "Unarchive" : "Archive"}
                            </button>`
                        }
                        ${
                            !archived &&
                            html`<button class="button small" onClick=${pinChosen}>
                                ${allPinned ? "Unpin" : "Pin"}
                            </button>`
                        }
                        <button
                            class="icon-button small"
                            title="Clear the selection (Esc)"
                            aria-label="Clear the selection"
                            onClick=${clearSelection}
                        >
                            <${Icon} name="close" size=${14} />
                        </button>
                    </div>`
                }
            </div>
            <button
                class="me-row"
                title="Your name"
                onClick=${() => openSheet({ type: "settings", tab: "account" })}
            >
                ${me && html`<${Avatar} person=${me} size=${22} />`}
                <span class="me-name">${me?.name}</span>
                <span class="me-role">
                    ${me?.role === "owner" ? "owner" : me?.role === "viewer" ? "view only" : "guest"}
                </span>
            </button>
        </div>
    </div>`;
}

/**
 * Subagents across the sessions, by state, as the rail counts them: archived sessions only while a subagent works
 * there, as the subagents board shows them.
 */
export function subagentTotals(sessions = store.state.sessions) {
    const totals = { working: 0, waiting: 0, failed: 0, stopped: 0, done: 0, dealt: 0 };

    for (const session of sessions) {
        const counts = session.subagents;

        if (!counts || (session.archived && !counts.working && !counts.waiting)) {
            continue;
        }

        for (const state of Object.keys(totals)) {
            totals[state] += counts[state] ?? 0;
        }
    }

    return totals;
}

/** Open the subagents board in the conversation's place, or close it. */
export const toggleBoard = () =>
    store.set((state) =>
        state.board
            ? { board: false, boardAgents: null }
            : { board: true, drawer: false, page: null },
    );

/** The sidebar folded: Pi, new, the launcher, then numbered sessions like Waybar's workspaces. */
export function Rail() {
    const { conversationId } = store.state;
    const canStart = canSteer() && !scoped();
    const items = useRef(null);
    const order = workspaceOrder();
    const indicator = useSlide(items, ".ws.active");

    return html`<div class="rail">
        <button
            class="rail-brand"
            title="Unfold the sidebar"
            aria-label="Unfold the sidebar"
            onClick=${() => setPrefs({ sidebar: "open" })}
        >
            π
        </button>
        ${
            canStart &&
            html`<button
                class="icon-button"
                title="New session"
                aria-label="New session"
                onClick=${() => openSheet({ type: "cwd", mode: "new" })}
            >
                <${Icon} name="plus" size=${18} />
            </button>`
        }
        <button
            class="icon-button"
            title="Launcher"
            aria-label="Open the launcher"
            onClick=${() => store.set({ launcher: true })}
        >
            <${Icon} name="command" size=${18} />
        </button>
        ${
            store.state.me?.role === "owner" &&
            html`<button
                class=${`icon-button ${store.state.sidebarTab === "private" ? "on" : ""}`}
                aria-label="Private Herdr panes"
                title="Private Herdr panes"
                onClick=${() => {
                    store.set({ sidebarTab: "private" });
                    setPrefs({ sidebar: "open" });
                }}
            >
                <${Icon} name="terminal" size=${18} />
            </button>`
        }
        <div class="rail-items" ref=${items}>
            <${Slide} box=${indicator} />
            ${order.map(
                (session, index) =>
                    html`<button
                        key=${session.id}
                        class=${`ws ${rowIsOpen(session, conversationId) ? "active" : ""} ${session.busy ? "busy" : ""} ${session.waiting ? "waiting" : ""}`}
                        style=${`--i:${index}`}
                        title=${`${session.title ?? "New session"}${index < 9 ? `  (Alt ${index + 1})` : ""}`}
                        onClick=${() => navigate(rowOpenId(session))}
                    >
                        ${index < 9 ? index + 1 : initials(session.title ?? "New session")}
                        ${collab() && sessionUnread(session) && html`<span class="unread-dot"></span>`}
                    </button>`,
            )}
        </div>
        <div class="rail-foot">
            <${PeeksRailButton} />
            <${PipRailButton} />
            <button
                class="icon-button"
                title="Subagents"
                aria-label="Subagents"
                onClick=${toggleBoard}
            >
                <${Icon} name="fork" size=${18} />
            </button>
            <${ExtensionRailButtons} />
            <button
                class="icon-button"
                title="Running now"
                onClick=${() => openSheet({ type: "running" })}
            >
                <${Icon} name="pulse" size=${18} />
            </button>
            <button
                class="icon-button"
                title="Unfold the sidebar"
                aria-label="Unfold the sidebar"
                onClick=${() => setPrefs({ sidebar: "open" })}
            >
                <${Icon} name="sidebar" size=${18} />
            </button>
            <button
                class="icon-button"
                title="Settings"
                aria-label="Settings"
                onClick=${() => openSheet({ type: "settings" })}
            >
                <${Icon} name="settings" size=${18} />
            </button>
        </div>
    </div>`;
}

/** The folded sidebar's sessions, numbered like Waybar's workspaces. */
function RailTiles() {
    const { conversationId } = store.state;
    const items = useRef(null);
    const order = workspaceOrder();
    const indicator = useSlide(items, ".ws.active");

    return html`<div class="rail-items" ref=${items}>
        <${Slide} box=${indicator} />
        ${order.map(
            (session, index) =>
                html`<button
                    key=${session.id}
                    class=${`ws ${rowIsOpen(session, conversationId) ? "active" : ""} ${session.busy ? "busy" : ""} ${session.waiting ? "waiting" : ""}`}
                    style=${`--i:${index}`}
                    title=${`${session.title ?? "New session"}${index < 9 ? ` (Alt+${index + 1})` : ""}`}
                    aria-label=${`${session.title ?? "New session"}${session.waiting ? ", needs you" : session.busy ? ", working" : ""}`}
                    aria-current=${rowIsOpen(session, conversationId) ? "page" : undefined}
                    onClick=${() => navigate(rowOpenId(session))}
                >
                    ${index < 9 ? index + 1 : initials(session.title ?? "New session")}
                    ${
                        (session.members ?? [session]).some(
                            (member) =>
                                member.id !== conversationId &&
                                ((collab() && sessionUnread(member)) || isUnread(member.id)),
                        ) && html`<span class="unread-dot"></span>`
                    }
                </button>`,
        )}
    </div>`;
}

/**
 * The rail beside the session list: Pi (home), the sessions (which fold the sidebar), then the tools (peek tiles, PiP,
 * running now, the subagents board, people, providers, the theme) and you. Folded, it holds the sessions too, numbered.
 * In the drawer and on a phone's home screen it does not fold, and Pi is a mark.
 */
export function RailNav({ foldable = false, folded = false }) {
    const { sessions, board, me } = store.state;
    const canStart = canSteer() && !scoped();
    const busy = sessions.filter((session) => session.busy).length;
    const agents = subagentTotals(sessions);
    const live = agents.working + agents.waiting;
    const failed = failing(agents);
    const keys = APPLE ? "⌘B" : "Ctrl+B";
    const fold = () => setPrefs({ sidebar: folded ? "open" : "rail" });
    const role = me?.role === "owner" ? "owner" : me?.role === "viewer" ? "view only" : "guest";

    return html`<nav class="rail" data-part="rail" aria-label="Sessions and tools">
        ${
            foldable
                ? html`<button
                      class="rail-brand"
                      data-part="brand-mark"
                      title="Home"
                      aria-label="Home"
                      onClick=${toSessions}
                  >
                      π
                  </button>`
                : html`<span class="rail-brand" data-part="brand-mark" aria-hidden="true">π</span>`
        }
        <span class="rail-gap"></span>
        ${
            foldable
                ? html`<button
                      class=${`rail-button ${folded ? "" : "on"}`}
                      data-part="rail-button"
                      data-state=${railState(!folded)}
                      title=${`Sessions (${keys} ${folded ? "unfolds" : "folds"} the list)`}
                      aria-label="Sessions"
                      aria-expanded=${!folded}
                      onClick=${fold}
                  >
                      <${Icon} name="chat" size=${19} />
                  </button>`
                : html`<span
                      class="rail-button on"
                      data-part="rail-button"
                      data-state="open"
                      title="Sessions"
                      aria-current="page"
                  >
                      <${Icon} name="chat" size=${19} />
                  </span>`
        }
        ${!folded && html`<span class="rail-fill"></span>`}
        ${
            folded &&
            canStart &&
            html`<button
                class="rail-button rail-new"
                data-part="rail-button"
                title="New session (Alt+N)"
                aria-label="New session"
                onClick=${() => openSheet({ type: "cwd", mode: "new" })}
            >
                <${Icon} name="plus" size=${19} />
            </button>`
        }
        ${folded && html`<${RailTiles} />`} ${foldable && html`<${PeeksRailButton} />`}
        <${PipRailButton} />
        <button
            class=${`rail-button rail-running ${busy > 0 ? "lit" : ""}`}
            data-part="rail-button"
            data-state=${railState(false, busy > 0)}
            title="Running now"
            aria-label=${busy > 0 ? `Running now, ${busy}` : "Running now"}
            onClick=${() => openSheet({ type: "running" })}
        >
            <${Icon} name="pulse" size=${19} />
            ${busy > 0 && html`<span class="rail-count">${busy}</span>`}
        </button>
        <button
            class=${`rail-button rail-agents ${live > 0 ? "lit" : ""} ${board ? "open" : ""}`}
            data-part="rail-button"
            data-state=${railState(board, live > 0)}
            title="Subagents in every session"
            aria-label=${[
                "Subagents",
                live > 0 && `${live} at work`,
                agents.waiting > 0 && `${agents.waiting} waiting for approval`,
                failed > 0 && `${failed} failed`,
            ]
                .filter(Boolean)
                .join(", ")}
            aria-pressed=${board}
            onClick=${toggleBoard}
        >
            <${Icon} name="fork" size=${19} />
            ${live > 0 && html`<span class="rail-count">${live}</span>`}
            ${
                (failed > 0 || agents.waiting > 0) &&
                html`<span class="rail-trouble" aria-hidden="true"></span>`
            }
        </button>
        <${ExtensionRailButtons} />
        ${
            collab()
                ? html`<button
                      class="rail-button"
                      data-part="rail-button"
                      title=${canStart ? "People and invites" : "People"}
                      aria-label="People"
                      onClick=${() => openSheet({ type: "people" })}
                  >
                      <${Icon} name="users" size=${19} />
                  </button>`
                : html`<button
                      class="rail-button"
                      data-part="rail-button"
                      title="Sign in another device"
                      aria-label="Devices"
                      onClick=${() => openSheet({ type: "invite" })}
                  >
                      <${Icon} name="users" size=${19} />
                  </button>`
        }
        ${
            me?.role === "owner" &&
            html`<button
                class="rail-button"
                data-part="rail-button"
                title="Model providers"
                aria-label="Providers"
                onClick=${() => openSheet({ type: "providers" })}
            >
                <${Icon} name="key" size=${19} />
            </button>`
        }
        <button
            class="rail-button"
            data-part="rail-button"
            title="Theme, tiling, motion"
            aria-label="Theme"
            onClick=${() => openSheet({ type: "appearance" })}
        >
            <${Icon} name="palette" size=${19} />
        </button>
        <button
            class="rail-button rail-me"
            data-part="rail-button"
            title=${`${me?.name ?? ""} · ${role}`}
            aria-label="Your name"
            onClick=${() => openSheet({ type: "name" })}
        >
            ${me && html`<${Avatar} person=${me} size=${30} />`}
        </button>
    </nav>`;
}

/** Coop shows either its standalone session list or its folded rail, never a rail beside the list. */
const LIST_MIN = 260;
const LIST_MAX = 520;

/** The standalone sidebar's usual width. */
export const SIDEBAR_WIDTH = 300;

/** Drag the sidebar's right edge to resize its list; a double click puts it back to its usual width. */
export function ResizeHandle() {
    const ref = useRef(null);
    // A theme may put the sidebar on the right: the handle goes to its other edge, and drags the other way.
    const side = useSide(ref, (handle) => handle.parentElement);

    const start = (event) => {
        if (event.button !== 0) {
            return;
        }

        event.preventDefault();
        const root = document.documentElement;
        const sidebar = event.currentTarget.parentElement;
        const box = sidebar.getBoundingClientRect();
        let width = prefs().sidebarWidth;

        root.classList.add("resizing");

        const move = (each) => {
            const across = side === "right" ? box.right - each.clientX : each.clientX - box.left;

            width = Math.round(Math.min(LIST_MAX, Math.max(LIST_MIN, across)));
            root.style.setProperty("--sidebar-w", `${width}px`);
        };

        const stop = () => {
            root.classList.remove("resizing");
            removeEventListener("pointermove", move);
            removeEventListener("pointerup", stop);
            removeEventListener("pointercancel", stop);
            setPrefs({ sidebarWidth: width });
        };

        addEventListener("pointermove", move);
        addEventListener("pointerup", stop);
        addEventListener("pointercancel", stop);
    };

    return html`<div
        class=${`resize-handle ${side === "right" ? "at-left" : ""}`}
        ref=${ref}
        role="separator"
        aria-orientation="vertical"
        title="Drag to resize"
        onPointerDown=${start}
        onDblClick=${() => setPrefs({ sidebarWidth: SIDEBAR_WIDTH })}
    ></div>`;
}

/** The rail and the session list, sliding in from the left on narrow screens. */
export function Drawer() {
    const [open, leaving] = usePresence(store.state.drawer || null, 200);
    const ref = useRef(null);
    const close = () => store.set({ drawer: false });
    // A theme may slide it in from the right: it is dragged back that way.
    const side = useSide(ref);

    useBack(store.state.drawer === true, close);
    // Not under a row's actions, which a long press opens over it: the finger that opened them may still move.
    useDragToClose(ref, {
        dir: side,
        onClose: close,
        enabled: Boolean(open) && !leaving && !store.state.sheet,
    });
    // Esc closes it, as it does a sheet; one over it closes first.
    useEffect(() => {
        if (!open || leaving) {
            return undefined;
        }

        const onKey = (event) => {
            if (
                event.key === "Escape" &&
                !event.defaultPrevented &&
                !store.state.sheet &&
                !store.state.launcher
            ) {
                event.preventDefault();
                close();
            }
        };

        addEventListener("keydown", onKey);

        return () => removeEventListener("keydown", onKey);
    }, [open, leaving]);

    if (!open) {
        return null;
    }

    return html`<div class=${leaving ? "leaving" : ""} inert=${leaving}>
        <div
            class="overlay drawer-overlay"
            data-part="scrim"
            data-for="drawer"
            onMouseDown=${scrimPress(close)}
        >
            <aside
                class="drawer"
                data-part="drawer"
                data-state=${leaving ? "closing" : undefined}
                ref=${ref}
            >
                <${SessionList} compact=${true} />
            </aside>
        </div>
    </div>`;
}
