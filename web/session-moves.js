// Moving threads changes catalogue placement only; the server owns permissions and durable state.
import { useLayoutEffect, useRef, useState } from "preact/hooks";
import {
    actions,
    canSteer,
    handoffsAvailable,
    notify,
    projectsAvailable,
    scoped,
    store,
} from "./store.js";
import { organizationTargets } from "./work-items.js";

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

/** Each independent thread or whole Work Item is one transaction; mixed selections report partial failures. */
export async function moveSessions(ids, destination) {
    const targets = organizationTargets(ids, store.state.sessions, handoffsAvailable()).filter(
        ({ id }) => {
            const session = store.state.sessions.find((each) => each.id === id);

            return !session || !samePlacement(session, destination);
        },
    );
    const results = await Promise.allSettled(
        targets.map(async ({ id, workItemId }) => {
            const key = workItemId ?? id;

            if (inFlight.has(key)) {
                throw new Error("This session is already being moved. Wait for it to finish.");
            }

            inFlight.add(key);

            try {
                const patch = {
                    projectId: destination.projectId,
                    goalId: destination.goalId,
                };

                if (workItemId) {
                    await actions.updateWorkItem(id, patch);
                } else {
                    await actions.updateSession(id, patch);
                }
            } finally {
                inFlight.delete(key);
            }
        }),
    );
    const completed = targets.filter((_, index) => results[index].status === "fulfilled");
    const moved = completed.flatMap((target) => target.ids);
    const failed = targets
        .filter((_, index) => results[index].status === "rejected")
        .map((target) => target.id);
    const failure = results.find((result) => result.status === "rejected");
    const noun = targets.some((target) => target.workItemId) ? "items" : "sessions";
    const error = failure
        ? `${completed.length ? `Moved ${completed.length} of ${targets.length} ${noun}. ` : ""}${failure.reason?.message ?? String(failure.reason)}`
        : "";

    if (moved.length && !error) {
        notify(
            "info",
            `Moved ${completed.length === 1 ? (completed[0].workItemId ? "Work Item" : "session") : `${completed.length} ${noun}`} to ${destination.label}.`,
        );
    }

    return { moved, failed, error };
}

/** Native drag retains local provenance; touch drag owns its finger even if tab hover detaches its row. */
export function useSessionDrag(options) {
    const { enabled, list, selected } = options;
    const [drag, setDrag] = useState(null);
    const [busy, setBusy] = useState(false);
    const latest = useRef(options);
    const pending = useRef(false);
    const current = useRef(null);
    const source = useRef(null);
    const hover = useRef(null);
    const timer = useRef(0);
    const frame = useRef(0);
    const preview = useRef(0);
    const point = useRef(null);
    const suppressClick = useRef(0);
    const touching = useRef(false);

    latest.current = options;

    const clearHover = () => {
        clearTimeout(timer.current);
        timer.current = 0;
        hover.current = null;
    };

    const clearSource = () => {
        source.current?.();
        source.current = null;
    };

    const end = () => {
        const wasTouch = current.current?.kind === "touch";

        clearSource();
        clearHover();
        cancelAnimationFrame(preview.current);
        preview.current = 0;
        cancelAnimationFrame(frame.current);
        frame.current = 0;
        point.current = null;
        current.current = null;
        setDrag(null);

        if (wasTouch) {
            suppressClick.current = Date.now() + 800;
        } else {
            setTimeout(() => {
                // A new touch gesture must not inherit an old native drag's reset.
                if (!current.current) {
                    suppressClick.current = 0;
                }
            }, 0);
        }
    };

    const route = () =>
        `${store.state.conversationId}:${store.state.privateId}:${store.state.sidebarTab}`;

    const permitted = (destination) => {
        const goal = destination?.goalId
            ? store.state.projectGoals.find((each) => each.id === destination.goalId)
            : null;

        return (
            latest.current.enabled &&
            canMoveSessions() &&
            current.current &&
            current.current.route === route() &&
            (!destination?.goalId || (goal && !goal.archived))
        );
    };

    const accepts = (event, destination) =>
        current.current?.kind === "native" &&
        permitted(destination) &&
        event.dataTransfer?.types.includes(DRAG_TYPE);

    const hoverAt = (key, onOpen) => {
        if (hover.current === key) {
            return;
        }

        clearHover();
        hover.current = key;

        if (onOpen) {
            timer.current = setTimeout(() => {
                timer.current = 0;

                if (permitted()) {
                    onOpen();
                } else {
                    end();
                }
            }, 650);
        }
    };

    const over = (event, destination, onOpen) => {
        if (current.current?.kind !== "native") {
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

    const touchTarget = (position) => {
        const element = document.elementFromPoint(position.x, position.y);

        const scope = list.current?.closest(".sessions") ?? list.current;

        if (!element || !scope?.contains(element)) {
            return null;
        }

        const tab = element.closest('[data-session-projects-tab="true"]');

        if (tab) {
            return { tab };
        }

        const target = element.closest("[data-session-drop]");

        if (!target) {
            return null;
        }

        try {
            const destination = JSON.parse(target.dataset.sessionDrop);

            if (
                !destination ||
                (destination.projectId !== null && typeof destination.projectId !== "string") ||
                (destination.goalId !== null && typeof destination.goalId !== "string") ||
                typeof destination.key !== "string" ||
                typeof destination.label !== "string"
            ) {
                return null;
            }

            return { target, destination };
        } catch {
            return null;
        }
    };

    const highlightTouch = (position) => {
        if (current.current?.kind !== "touch") {
            return;
        }

        if (!permitted()) {
            end();

            return;
        }

        const hit = touchTarget(position);

        if (hit?.tab) {
            hoverAt("projects-tab", () => {
                if (touchTarget(point.current)?.tab === hit.tab) {
                    hit.tab.click();
                    highlightTouch(point.current);
                }
            });
        } else if (hit?.destination && permitted(hit.destination)) {
            hoverAt(
                hit.destination.key,
                hit.target.dataset.sessionDropClosed === "true"
                    ? () => {
                          const now = touchTarget(point.current);

                          if (
                              now?.target === hit.target &&
                              permitted(now.destination) &&
                              hit.target.dataset.sessionDropClosed === "true"
                          ) {
                              hit.target
                                  .querySelector(":scope > .project-group-head .group-head")
                                  ?.click();
                              highlightTouch(point.current);
                          }
                      }
                    : null,
            );
        } else {
            clearHover();
        }

        const destination = hit?.destination;
        const target = destination && permitted(destination) ? destination : null;

        if (current.current.target?.key !== target?.key) {
            current.current = { ...current.current, target };
            setDrag(current.current);
        }
    };

    const scrollAt = (position) => {
        point.current = position;

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

            if (!permitted()) {
                end();

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

            if (current.current.kind === "touch") {
                // Scrolling and disclosure can move the destination beneath a stationary finger.
                highlightTouch(position);
            }

            if (current.current) {
                frame.current = requestAnimationFrame(tick);
            }
        };

        frame.current = requestAnimationFrame(tick);
    };

    const place = async (ids, destination) => {
        pending.current = true;
        setBusy(true);

        try {
            const result = await moveSessions(ids, destination);

            if (result.error) {
                notify("error", result.error);
            }

            latest.current.onMoved(result.moved);
        } finally {
            pending.current = false;
            setBusy(false);
        }
    };

    const moveTouch = (position) => {
        if (current.current?.kind !== "touch") {
            return;
        }

        scrollAt(position);
        highlightTouch(position);
    };

    const endTouch = (position) => {
        if (current.current?.kind !== "touch") {
            return;
        }

        // Never trust the last highlight: release can occur over a different or archived target.
        const destination = touchTarget(position)?.destination;
        const ids = current.current.ids;
        const allowed = destination && permitted(destination);

        end();

        if (allowed) {
            void place(ids, destination);
        }
    };

    const cancelTouch = () => {
        if (current.current?.kind === "touch") {
            end();
        }
    };

    const touchEvents = useRef(null);

    useLayoutEffect(() => {
        const seen = new WeakSet();

        const track = (event) => {
            if (seen.has(event)) {
                return;
            }

            seen.add(event);
            touching.current = event.touches.length > 0;

            if (current.current?.kind !== "touch") {
                if (event.type === "touchstart" && !current.current) {
                    suppressClick.current = 0;
                }

                return;
            }

            if (event.cancelable) {
                event.preventDefault();
            }

            const identifier = current.current.identifier;
            const touches = event.type === "touchend" ? event.changedTouches : event.touches;
            const touch = [...touches].find(
                (each) => identifier === undefined || each.identifier === identifier,
            );

            if (
                event.type === "touchcancel" ||
                !touch ||
                (event.type === "touchend"
                    ? event.touches.length !== 0
                    : event.touches.length !== 1)
            ) {
                end();

                return;
            }

            const position = { x: touch.clientX, y: touch.clientY, identifier: touch.identifier };

            if (event.type === "touchend") {
                endTouch(position);
            } else {
                moveTouch(position);
            }
        };

        const cancel = (event) => {
            if (!current.current) {
                suppressClick.current = 0;

                return;
            }

            if (event.key === "Escape") {
                event.preventDefault();
                event.stopPropagation();
                end();
            }
        };

        const visibility = () => {
            if (document.hidden) {
                end();
            }
        };

        const unsubscribe = store.subscribe(() => {
            if (current.current && !permitted()) {
                end();
            }
        });

        const blockNativeTouchDrag = (event) => {
            const scope = list.current?.closest(".sessions") ?? list.current;

            if (
                current.current?.kind === "touch" ||
                (touching.current && scope?.contains(event.target))
            ) {
                event.preventDefault();
            }
        };

        const mouseDown = (event) => {
            if (event.pointerType === "mouse" && !event.sourceCapabilities?.firesTouchEvents) {
                // A cancelled touch may end on an already-detached node, outside document.
                // A genuine mouse press starts fresh; compatibility mouse events are not pointers.
                touching.current = false;

                if (!current.current) {
                    suppressClick.current = 0;
                }
            }
        };

        const blockCompatibilityClick = (event) => {
            if (
                event.detail > 0 &&
                suppressClick.current > Date.now() &&
                (event.sourceCapabilities?.firesTouchEvents || current.current?.kind === "touch")
            ) {
                event.preventDefault();
                event.stopImmediatePropagation();
                suppressClick.current = 0;
            }
        };

        touchEvents.current = track;

        for (const type of ["touchstart", "touchmove", "touchend", "touchcancel"]) {
            document.addEventListener(type, track, { capture: true, passive: false });
        }

        document.addEventListener("pointerdown", mouseDown, true);
        document.addEventListener("dragstart", blockNativeTouchDrag, true);
        document.addEventListener("click", blockCompatibilityClick, true);
        document.addEventListener("visibilitychange", visibility);
        addEventListener("blur", end);
        document.addEventListener("keydown", cancel, true);

        return () => {
            clearSource();
            clearHover();
            cancelAnimationFrame(preview.current);
            cancelAnimationFrame(frame.current);
            current.current = null;
            touchEvents.current = null;
            unsubscribe();

            for (const type of ["touchstart", "touchmove", "touchend", "touchcancel"]) {
                document.removeEventListener(type, track, true);
            }

            document.removeEventListener("pointerdown", mouseDown, true);
            document.removeEventListener("dragstart", blockNativeTouchDrag, true);
            document.removeEventListener("click", blockCompatibilityClick, true);
            document.removeEventListener("visibilitychange", visibility);
            removeEventListener("blur", end);
            document.removeEventListener("keydown", cancel, true);
        };
    }, []);

    useLayoutEffect(() => {
        if (!enabled) {
            end();
        }
    }, [enabled]);

    return {
        drag,
        busy,
        scroll: (event) => {
            if (accepts(event)) {
                scrollAt({ x: event.clientX, y: event.clientY });
            }
        },
        leaveList: (event) => {
            if (
                current.current?.kind === "native" &&
                !event.currentTarget.contains(event.relatedTarget)
            ) {
                point.current = null;
                cancelAnimationFrame(frame.current);
                frame.current = 0;
                clearHover();
            }
        },
        consumeClick: (event) => {
            if (event?.detail === 0) {
                return false;
            }

            const suppressed = suppressClick.current > Date.now();

            suppressClick.current = 0;

            return suppressed;
        },
        start: (event, id, ids) => {
            if (
                !latest.current.enabled ||
                pending.current ||
                touching.current ||
                current.current?.kind === "touch" ||
                !canMoveSessions() ||
                event.ctrlKey ||
                event.metaKey ||
                event.shiftKey
            ) {
                event.preventDefault();

                return;
            }

            suppressClick.current = 0;
            const moving = selected.current.has(id) ? ids : [id];

            event.dataTransfer.effectAllowed = "move";
            event.dataTransfer.setData(DRAG_TYPE, JSON.stringify(moving));
            const started = { ids: moving, target: null, kind: "native", route: route() };

            current.current = started;
            suppressClick.current = Infinity;
            clearSource();
            // Tab hover can detach this button and remove Preact's event proxy mid-drag.
            const element = event.currentTarget;

            element.addEventListener("dragend", end, { once: true });
            source.current = () => element.removeEventListener("dragend", end);
            // Let Chromium capture its native drag image before changing the source's layout/styles.
            preview.current = requestAnimationFrame(() => {
                preview.current = 0;

                if (current.current === started) {
                    setDrag(started);
                }
            });
        },
        startTouch: (position, id, ids) => {
            if (
                !latest.current.enabled ||
                pending.current ||
                current.current ||
                !canMoveSessions()
            ) {
                return false;
            }

            const moving = selected.current.has(id) ? ids : [id];

            if (!moving.length) {
                return false;
            }

            const started = {
                ids: moving,
                target: null,
                kind: "touch",
                identifier: position.identifier,
                route: route(),
            };

            current.current = started;
            suppressClick.current = Infinity;
            setDrag(started);
            // Native touch events can remain targeted at a detached source. Keep that listener
            // alongside the document tracker until release; the tracker deduplicates bubbling events.
            const element = position.source;
            const listener = touchEvents.current;

            if (element && listener) {
                for (const type of ["touchstart", "touchmove", "touchend", "touchcancel"]) {
                    element.addEventListener(type, listener, { capture: true, passive: false });
                }

                source.current = () => {
                    for (const type of ["touchstart", "touchmove", "touchend", "touchcancel"]) {
                        element.removeEventListener(type, listener, true);
                    }
                };
            }

            moveTouch(position);

            return true;
        },
        moveTouch,
        endTouch,
        cancelTouch,
        over,
        leave: (event) => {
            if (
                current.current?.kind !== "native" ||
                event.currentTarget.contains(event.relatedTarget)
            ) {
                return;
            }

            event.stopPropagation();
            clearHover();
            setDrag({ ...current.current, target: null });
        },
        drop: async (event, destination) => {
            if (current.current?.kind !== "native") {
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
            await place(ids, destination);
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
