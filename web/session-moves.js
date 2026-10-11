// Moving threads changes catalogue placement only; the server owns permissions and durable state.
import { useEffect, useRef, useState } from "preact/hooks";
import { actions, canSteer, notify, projectsAvailable, scoped, store } from "./store.js";

const DRAG_TYPE = "application/x-pi-coop-sessions";
const inFlight = new Set();

export function canMoveSessions() {
    return projectsAvailable() && canSteer() && !scoped();
}

export function samePlacement(session, destination) {
    return (
        (session.projectId ?? null) === destination.projectId &&
        (session.goalId ?? null) === destination.goalId
    );
}

/** Multi-row moves report partial failures honestly; each thread is its own server transaction. */
export async function moveSessions(ids, destination) {
    const targets = [...new Set(ids)].filter((id) => {
        const session = store.state.sessions.find((each) => each.id === id);

        return !session || !samePlacement(session, destination);
    });
    const results = await Promise.allSettled(
        targets.map(async (id) => {
            if (inFlight.has(id)) {
                throw new Error("This session is already being moved. Wait for it to finish.");
            }

            inFlight.add(id);

            try {
                await actions.updateSession(id, {
                    projectId: destination.projectId,
                    goalId: destination.goalId,
                });
            } finally {
                inFlight.delete(id);
            }
        }),
    );
    const moved = targets.filter((_, index) => results[index].status === "fulfilled");
    const failed = targets.filter((_, index) => results[index].status === "rejected");
    const failure = results.find((result) => result.status === "rejected");
    const error = failure
        ? `${moved.length ? `Moved ${moved.length} of ${targets.length} sessions. ` : ""}${failure.reason?.message ?? String(failure.reason)}`
        : "";

    if (moved.length && !error) {
        notify(
            "info",
            `Moved ${moved.length === 1 ? "session" : `${moved.length} sessions`} to ${destination.label}.`,
        );
    }

    return { moved, failed, error };
}

/** Native desktop drag, with local provenance: files and drags from other tabs never move threads. */
export function useSessionDrag({ enabled, list, selected, onMoved }) {
    const [drag, setDrag] = useState(null);
    const [busy, setBusy] = useState(false);
    const current = useRef(null);
    const source = useRef(null);
    const hover = useRef(null);
    const timer = useRef(0);
    const frame = useRef(0);
    const preview = useRef(0);
    const point = useRef(null);
    const suppressClick = useRef(false);

    const clearHover = () => {
        clearTimeout(timer.current);
        timer.current = 0;
        hover.current = null;
    };

    const clearSource = () => {
        if (source.current) {
            const { element, listener } = source.current;

            source.current = null;
            element.removeEventListener("dragend", listener);
        }
    };

    const end = () => {
        clearSource();
        clearHover();
        cancelAnimationFrame(preview.current);
        preview.current = 0;
        cancelAnimationFrame(frame.current);
        frame.current = 0;
        point.current = null;
        current.current = null;
        setDrag(null);
        setTimeout(() => {
            suppressClick.current = false;
        }, 0);
    };

    useEffect(() => {
        const cancel = (event) => {
            if (!event || event.key === "Escape") {
                end();
            }
        };

        addEventListener("blur", end);
        addEventListener("keydown", cancel);

        return () => {
            clearSource();
            clearHover();
            cancelAnimationFrame(preview.current);
            cancelAnimationFrame(frame.current);
            current.current = null;
            removeEventListener("blur", end);
            removeEventListener("keydown", cancel);
        };
    }, []);

    useEffect(() => {
        end();
    }, [enabled]);

    const accepts = (event, destination) => {
        const goal = destination?.goalId
            ? store.state.projectGoals.find((each) => each.id === destination.goalId)
            : null;

        return (
            enabled &&
            canMoveSessions() &&
            current.current &&
            event.dataTransfer?.types.includes(DRAG_TYPE) &&
            (!destination?.goalId || (goal && !goal.archived))
        );
    };

    const hoverAt = (key, onOpen) => {
        if (hover.current === key) {
            return;
        }

        clearHover();
        hover.current = key;

        if (onOpen) {
            timer.current = setTimeout(onOpen, 650);
        }
    };

    const over = (event, destination, onOpen) => {
        if (!current.current) {
            return;
        }

        // A goal consumes the event even when it refuses the drop; its parent is not a fallback.
        event.stopPropagation();

        if (!accepts(event, destination)) {
            event.dataTransfer.dropEffect = "none";
            clearHover();
            setDrag({ ...current.current, target: null });

            return;
        }

        event.preventDefault();
        event.dataTransfer.dropEffect = "move";
        hoverAt(destination.key, onOpen);
        setDrag({ ...current.current, target: destination });
    };

    const scroll = (event) => {
        if (!accepts(event)) {
            return;
        }

        point.current = { x: event.clientX, y: event.clientY };

        if (frame.current) {
            return;
        }

        const tick = () => {
            const box = list.current;
            const position = point.current;

            if (!box || !position || !current.current) {
                frame.current = 0;

                return;
            }

            const rect = box.getBoundingClientRect();
            const edge = 36;
            const past =
                position.y < rect.top + edge
                    ? position.y - rect.top - edge
                    : position.y > rect.bottom - edge
                      ? position.y - rect.bottom + edge
                      : 0;

            if (
                position.x >= rect.left &&
                position.x <= rect.right &&
                position.y >= rect.top &&
                position.y <= rect.bottom &&
                past
            ) {
                box.scrollTop += Math.max(-16, Math.min(16, past / 3));
            }

            frame.current = requestAnimationFrame(tick);
        };

        frame.current = requestAnimationFrame(tick);
    };

    return {
        drag,
        busy,
        scroll,
        leaveList: (event) => {
            if (!event.currentTarget.contains(event.relatedTarget)) {
                point.current = null;
                cancelAnimationFrame(frame.current);
                frame.current = 0;
                clearHover();
            }
        },
        consumeClick: () => {
            const suppressed = suppressClick.current;

            suppressClick.current = false;

            return suppressed;
        },
        start: (event, id, ids) => {
            suppressClick.current = false;

            if (
                !enabled ||
                busy ||
                !canMoveSessions() ||
                event.ctrlKey ||
                event.metaKey ||
                event.shiftKey
            ) {
                event.preventDefault();

                return;
            }

            const moving = selected.current.has(id) ? ids : [id];

            event.dataTransfer.effectAllowed = "move";
            event.dataTransfer.setData(DRAG_TYPE, JSON.stringify(moving));
            const started = { ids: moving, target: null };

            current.current = started;
            suppressClick.current = true;
            clearSource();
            // Tab hover can detach this button and remove Preact's event proxy mid-drag.
            // Keep dragend on the original native source until it finishes, even when detached.
            source.current = { element: event.currentTarget, listener: end };
            source.current.element.addEventListener("dragend", end, { once: true });
            // Let Chromium capture its native drag image before changing the source's layout/styles.
            preview.current = requestAnimationFrame(() => {
                preview.current = 0;

                if (current.current === started) {
                    setDrag(started);
                }
            });
        },
        over,
        leave: (event) => {
            if (event.currentTarget.contains(event.relatedTarget)) {
                return;
            }

            event.stopPropagation();
            clearHover();

            if (current.current) {
                setDrag({ ...current.current, target: null });
            }
        },
        drop: async (event, destination) => {
            if (!current.current) {
                return;
            }

            event.stopPropagation();

            if (!accepts(event, destination)) {
                end();

                return;
            }

            event.preventDefault();
            const ids = current.current.ids;

            end();
            setBusy(true);

            try {
                const result = await moveSessions(ids, destination);

                if (result.error) {
                    notify("error", result.error);
                }

                onMoved(result.moved);
            } finally {
                setBusy(false);
            }
        },
        hoverProjects: (event, onOpen) => {
            if (!accepts(event)) {
                return;
            }

            event.preventDefault();
            hoverAt("projects-tab", onOpen);
        },
        leaveProjects: clearHover,
    };
}
