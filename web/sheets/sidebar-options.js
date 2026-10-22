// Object-specific sidebar menus invoke existing actions without opening a different conversation first.
import { useContext, useEffect, useLayoutEffect, useRef, useState } from "preact/hooks";
import { canMoveSessions } from "../session-moves.js";
import { openSidebarOptions } from "../sidebar-context.js";
import { selectFromList, setArchived } from "../sessions.js";
import {
    canSteer,
    closeSheet,
    handoffsAvailable,
    isUnread,
    notify,
    openSheet,
    scoped,
    setUnread,
    store,
    uid,
} from "../store.js";
import { isPinned, togglePin } from "../theme.js";
import { copyText, html, Icon, Sheet, SheetInfo } from "../ui.js";

const NARROW = matchMedia("(max-width: 699px)");

/** Contact-positioned tablet/desktop menu, using the existing popup surface and sheets' Back stack. */
export function OptionsSurface({ title, at, bottom: mobile, children }) {
    const ref = useRef(null);
    const [position, setPosition] = useState({ left: at?.x ?? 8, top: at?.y ?? 8 });
    const closing = useContext(SheetInfo)?.closing;

    useLayoutEffect(() => {
        if (mobile || !ref.current) {
            return;
        }

        const rect = ref.current.getBoundingClientRect();
        const style = getComputedStyle(document.documentElement);
        const safeLeft = parseFloat(style.getPropertyValue("--safe-left")) || 0;
        const safeRight = parseFloat(style.getPropertyValue("--safe-right")) || 0;
        const viewport = visualViewport;
        const top = viewport?.offsetTop ?? 0;
        const bottom = top + (viewport?.height ?? innerHeight);

        setPosition({
            left: Math.max(
                safeLeft + 8,
                Math.min(at?.x ?? 8, innerWidth - safeRight - rect.width - 8),
            ),
            top: Math.max(top + 8, Math.min(at?.y ?? 8, bottom - rect.height - 8)),
        });
    }, [mobile, at]);
    useEffect(() => {
        // The shared Sheet owns mobile focus and Escape. A leaving menu must not handle a new layer's keys.
        if (mobile || closing) {
            return;
        }

        const previous = document.activeElement;
        const box = ref.current;

        (box?.querySelector('button[role="menuitem"]:not(:disabled)') ?? box)?.focus({
            preventScroll: true,
        });

        const key = (event) => {
            if (
                event.key === "Escape" &&
                !event.defaultPrevented &&
                !event.isComposing &&
                event.keyCode !== 229
            ) {
                event.preventDefault();
                closeSheet();
            }
        };

        const resize = () => closeSheet();

        addEventListener("keydown", key);
        addEventListener("resize", resize);

        return () => {
            removeEventListener("keydown", key);
            removeEventListener("resize", resize);

            if (
                previous?.isConnected &&
                (!document.activeElement ||
                    document.activeElement === document.body ||
                    box?.contains(document.activeElement))
            ) {
                previous.focus({ preventScroll: true });
            }
        };
    }, [mobile, closing]);

    if (mobile) {
        return html`<${Sheet}
            title=${title}
            onClose=${closeSheet}
            bottom=${true}
            class="sidebar-options-sheet"
        >
            ${children}
        <//>`;
    }

    const onKey = (event) => {
        const items = [...ref.current.querySelectorAll('button[role="menuitem"]:not(:disabled)')];
        const index = items.indexOf(document.activeElement);
        let next;

        if (event.key === "ArrowDown") {
            next = (index + 1) % items.length;
        } else if (event.key === "ArrowUp") {
            next = (index - 1 + items.length) % items.length;
        } else if (event.key === "Home") {
            next = 0;
        } else if (event.key === "End") {
            next = items.length - 1;
        } else if (event.key === "Tab") {
            closeSheet();

            return;
        } else {
            return;
        }

        event.preventDefault();
        items[next]?.focus();
    };

    return html`<div
        class="overlay pop-overlay sidebar-options-overlay"
        onClick=${(event) => event.target === event.currentTarget && closeSheet()}
        onContextMenu=${(event) => {
            event.preventDefault();
            closeSheet();
        }}
    >
        <section
            class="pop-menu sidebar-options-menu"
            ref=${ref}
            style=${`left:${position.left}px;top:${position.top}px`}
            role="menu"
            tabindex="-1"
            data-keyboard=${Boolean(at?.keyboard)}
            aria-label=${title}
            onKeyDown=${onKey}
        >
            <div class="sidebar-options-title">${title}</div>
            ${children}
        </section>
    </div>`;
}

export function SidebarOptions({ kind, id, at }) {
    const { sessions, projects } = store.state;
    const thread =
        kind === "thread" || kind === "work-item" ? sessions.find((each) => each.id === id) : null;
    const grouped = handoffsAvailable() && Boolean(thread?.workItemId);
    const workItem = grouped && kind === "work-item";
    const members = workItem
        ? sessions.filter((each) => each.workItemId === thread.workItemId)
        : [];
    const project = kind === "project" ? projects.find((each) => each.id === id) : null;
    const object = thread ?? project;
    const title = workItem
        ? (thread.workItemTitle ?? "Work Item")
        : thread
          ? (thread.title ?? "New session")
          : (object?.name ?? "Options");
    const organize = canMoveSessions();
    const [busy, setBusy] = useState(false);
    const [error, setError] = useState("");
    const pending = useRef(false);
    // Coarse pointers also include iPads with trackpads. Only cramped touch openings need a sheet;
    // a mouse or keyboard context request stays anchored even in narrow Split View.
    const bottom = NARROW.matches && !at?.keyboard && (!at || at.touch);
    const items = [];
    const add = (label, icon, run, danger = false) => items.push({ label, icon, run, danger });

    if (thread) {
        const pinned = workItem ? members.some((member) => isPinned(member.id)) : isPinned(id);

        add(pinned ? "Unpin" : "Pin to the top", "pin", () => {
            if (workItem && pinned) {
                for (const member of members) {
                    if (isPinned(member.id)) {
                        togglePin(member.id);
                    }
                }
            } else {
                togglePin(id);
            }
        });

        if (!thread.archived) {
            add(isUnread(id) ? "Mark read" : "Mark unread", "unread", () =>
                setUnread(id, !isUnread(id)),
            );
        }

        add("Select", "check", () => {
            // Close before adding the selection's Back layer, as SessionActions does.
            closeSheet();
            selectFromList(id);
        });

        if (!workItem && canSteer()) {
            add("Rename…", "pencil", () => openSheet({ type: "rename", id }));
        }

        if (grouped && !workItem) {
            add("Work Item options…", "target", () =>
                openSidebarOptions("work-item", id, at, { keepDrawer: true }),
            );
        }

        if (workItem && store.state.me?.role === "owner" && !thread.archived) {
            const userId = store.state.me.id;
            const workItemId = thread.workItemId;
            const controllerId = thread.supervisor?.conversationId;
            const epoch = thread.supervisor?.epoch;
            const status = thread.supervisor?.status;
            const viewId = store.state.conversationId;
            const opening = store.state.sheet;

            const requireCurrent = () => {
                const current = store.state;
                const target = current.sessions.find((each) => each.id === id);

                if (
                    current.me?.id !== userId ||
                    current.me?.role !== "owner" ||
                    current.conversationId !== viewId ||
                    current.sheet !== opening ||
                    !handoffsAvailable() ||
                    target?.workItemId !== workItemId ||
                    target.archived ||
                    target.supervisor?.conversationId !== controllerId ||
                    target.supervisor?.epoch !== epoch ||
                    target.supervisor?.status !== status
                ) {
                    throw new Error(
                        "This Work Item changed. Reopen its options before continuing.",
                    );
                }
            };

            if (controllerId !== undefined) {
                add("Limits…", "settings", () => {
                    requireCurrent();
                    const opening = uid();

                    openSheet({
                        type: "work-item-limits",
                        id,
                        userId,
                        workItemId,
                        viewId,
                        opening,
                    });
                });
            }
        }

        if ((!grouped || workItem) && canMoveSessions()) {
            add(workItem ? "Move Work Item to project…" : "Move to project…", "folder", () =>
                openSheet({ type: "move-sessions", ids: [id] }),
            );
        }

        add("Copy link", "link", async () => {
            await copyText(new URL(`/s/${id}`, location.origin).href);
            notify("info", "Link copied. Other signed-in devices can open it.");
        });

        if ((!grouped || workItem) && canSteer()) {
            add(
                workItem
                    ? thread.archived
                        ? "Restore Work Item"
                        : "Archive Work Item"
                    : thread.archived
                      ? "Restore thread"
                      : "Archive thread",
                thread.archived ? "unarchive" : "archive",
                () => setArchived([id], !thread.archived),
                !thread.archived,
            );
        }
    } else if (project) {
        if (canSteer() && !scoped()) {
            add("New Session here…", "plus", () =>
                openSheet({ type: "new-session", projectId: id }),
            );
        }

        if (organize) {
            add("Edit project…", "pencil", () => openSheet({ type: "project", projectId: id }));
        }
    }

    const run = async (item) => {
        if (pending.current) {
            return;
        }

        const opened = store.state.sheet;

        pending.current = true;
        setBusy(true);
        setError("");

        try {
            await item.run();

            if (store.state.sheet === opened) {
                closeSheet();
            }
        } catch (failure) {
            setError(failure.message ?? String(failure));
        } finally {
            pending.current = false;
            setBusy(false);
        }
    };

    return html`<${OptionsSurface} title=${title} at=${at} bottom=${bottom}>
        ${!object && html`<p class="muted small">This item is no longer available.</p>`}
        ${object && !items.length && html`<p class="muted small">No actions available.</p>`}
        ${items.map(
            (item) => html`<button
                class=${`sidebar-option ${item.danger ? "danger" : ""}`}
                role=${bottom ? undefined : "menuitem"}
                tabindex=${bottom ? undefined : -1}
                disabled=${busy}
                onClick=${() => run(item)}
            >
                <${Icon} name=${item.icon} size=${16} />
                <span>${item.label}</span>
            </button>`,
        )}
        ${error && html`<p class="error sidebar-options-error" role="alert">${error}</p>`}
    <//>`;
}
