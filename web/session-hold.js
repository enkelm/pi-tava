// A deliberate touch hold reveals actions; only a fresh slide and dwell can commit one.
import { useLayoutEffect, useRef, useState } from "preact/hooks";
import { consumeHeldContact } from "./sidebar-context.js";

const HOLD_MS = 450;
const EXPAND_MS = 600;
const FILL_MS = 140;
const SLIDE_PX = 8;

export function useSessionHold(options) {
    const { ref, enabled, canDrag } = options;
    const latest = useRef(options);
    const controller = useRef(null);
    const suppressed = useRef(0);
    const [hold, setHold] = useState(null);

    latest.current = options;

    useLayoutEffect(() => {
        const row = ref.current;

        if (!row) {
            return;
        }

        let gesture = null;
        let timer = 0;
        let watching = false;

        const show = (choice, phase) => {
            setHold({ choice, phase, expandMs: EXPAND_MS, fillMs: FILL_MS });
        };

        const consume = () => {
            suppressed.current = Date.now() + 800;
        };

        const detach = () => {
            document.removeEventListener("touchstart", second, true);
            document.removeEventListener("touchmove", move, true);
            document.removeEventListener("touchend", release, true);
            document.removeEventListener("touchcancel", cancel, true);
            document.removeEventListener("scroll", scrolled, true);
            document.removeEventListener("visibilitychange", visibility);
            removeEventListener("blur", cancel);
            document.removeEventListener("keydown", escape, true);
            watching = false;
        };

        const finish = (cancelDrag = false) => {
            clearTimeout(timer);
            timer = 0;
            const previous = gesture;

            gesture = null;
            detach();
            setHold(null);

            if (previous?.phase !== "press" && previous) {
                consume();
            }

            if (cancelDrag && previous?.phase === "drag") {
                latest.current.onDragCancel?.();
            }
        };

        const cancel = () => finish(true);

        const visibility = () => {
            if (document.hidden) {
                cancel();
            }
        };

        const escape = (event) => {
            if (gesture && event.key === "Escape") {
                event.preventDefault();
                event.stopPropagation();
                cancel();
            }
        };

        const scrolled = () => {
            if (gesture && gesture.phase !== "drag" && gesture.phase !== "committed") {
                cancel();
            }
        };

        const second = (event) => {
            if (event.touches.length !== 1) {
                cancel();
            }
        };

        const position = (touch) => ({
            x: touch.clientX,
            y: touch.clientY,
            identifier: touch.identifier,
        });

        const half = (point) => {
            const rect = row.getBoundingClientRect();

            if (
                !row.isConnected ||
                point.x < rect.left ||
                point.x > rect.right ||
                point.y < rect.top ||
                point.y > rect.bottom
            ) {
                return null;
            }

            return point.x < rect.left + rect.width / 2 ? "drag" : "options";
        };

        const valid = () =>
            gesture &&
            latest.current.enabled &&
            row.isConnected &&
            (!gesture.choice || gesture.choice !== "drag" || latest.current.canDrag) &&
            half(gesture.point) === gesture.choice;

        const commit = () => {
            if (!valid()) {
                cancel();

                return;
            }

            const { choice, point } = gesture;

            clearTimeout(timer);
            timer = 0;
            consume();
            setHold(null);

            if (choice === "options") {
                gesture.phase = "committed";
                // The sheet can unmount a drawer row. Transfer release/click consumption first.
                consumeHeldContact({ identifier: point.identifier, source: gesture.source });
                latest.current.onOptions?.({ x: point.x, y: point.y, touch: true });
                finish();
            } else if (latest.current.onDragStart?.({ ...point, source: gesture.source })) {
                gesture.phase = "drag";
            } else {
                cancel();
            }
        };

        const neutral = () => {
            clearTimeout(timer);
            timer = 0;
            gesture.choice = null;
            gesture.phase = "choose";
            gesture.origin = gesture.point;
            show(null, "choose");
        };

        const choose = (choice) => {
            clearTimeout(timer);
            gesture.choice = choice;
            gesture.phase = "expand";
            show(choice, "expand");
            timer = setTimeout(() => {
                if (!valid()) {
                    cancel();

                    return;
                }

                gesture.phase = "fill";
                show(choice, "fill");
                timer = setTimeout(commit, FILL_MS);
            }, EXPAND_MS);
        };

        const move = (event) => {
            if (!gesture) {
                return;
            }

            const touch = [...event.touches].find(
                (each) => each.identifier === gesture.point.identifier,
            );

            if (event.touches.length !== 1 || !touch || !latest.current.enabled) {
                cancel();

                return;
            }

            gesture.point = position(touch);

            if (gesture.phase === "press") {
                if (
                    Math.hypot(
                        gesture.point.x - gesture.origin.x,
                        gesture.point.y - gesture.origin.y,
                    ) >= SLIDE_PX ||
                    !half(gesture.point)
                ) {
                    cancel();
                }

                return;
            }

            if (event.cancelable) {
                event.preventDefault();
            }

            if (gesture.phase === "drag") {
                latest.current.onDragMove?.(gesture.point);

                return;
            }

            if (gesture.phase === "committed") {
                return;
            }

            const choice = half(gesture.point);

            if (!choice) {
                cancel();

                return;
            }

            if (choice === "drag" && !latest.current.canDrag) {
                if (gesture.choice) {
                    neutral();
                }

                return;
            }

            if (gesture.choice && choice !== gesture.choice) {
                choose(choice);

                return;
            }

            if (
                gesture.phase === "choose" &&
                Math.hypot(
                    gesture.point.x - gesture.origin.x,
                    gesture.point.y - gesture.origin.y,
                ) >= SLIDE_PX &&
                (choice !== "drag" || latest.current.canDrag)
            ) {
                choose(choice);
            }
        };

        const release = (event) => {
            if (!gesture) {
                return;
            }

            const touch = [...event.changedTouches].find(
                (each) => each.identifier === gesture.point.identifier,
            );

            if (!touch || event.touches.length) {
                cancel();

                return;
            }

            const dragging = gesture.phase === "drag";
            const consumed = gesture.phase !== "press";
            const point = position(touch);

            if (consumed && event.cancelable) {
                event.preventDefault();
            }

            finish();

            if (dragging) {
                latest.current.onDragEnd?.(point);
            }
        };

        const start = (event) => {
            if (
                !latest.current.enabled ||
                event.touches.length !== 1 ||
                gesture ||
                event.target.closest(".session-side, [data-session-hold-action]")
            ) {
                return;
            }

            const point = position(event.touches[0]);

            suppressed.current = 0;
            gesture = { point, origin: point, source: event.target, phase: "press", choice: null };
            document.addEventListener("touchstart", second, true);
            document.addEventListener("touchmove", move, { capture: true, passive: false });
            document.addEventListener("touchend", release, { capture: true, passive: false });
            document.addEventListener("touchcancel", cancel, true);
            document.addEventListener("scroll", scrolled, true);
            document.addEventListener("visibilitychange", visibility);
            addEventListener("blur", cancel);
            document.addEventListener("keydown", escape, true);
            watching = true;
            timer = setTimeout(() => {
                if (!gesture || !latest.current.enabled || !row.isConnected) {
                    cancel();

                    return;
                }

                // Reset at reveal: movement during the initial press cannot arm an action.
                gesture.origin = gesture.point;
                gesture.phase = "choose";
                consume();
                show(null, "choose");
            }, HOLD_MS);
        };

        const context = (event) => {
            if (gesture) {
                event.preventDefault();
                event.stopImmediatePropagation();
            }
        };

        const nativeDrag = (event) => {
            if (gesture) {
                event.preventDefault();
                event.stopImmediatePropagation();
            }
        };

        const fresh = () => {
            if (!gesture) {
                suppressed.current = 0;
            }
        };

        const click = (event) => {
            if (event.detail > 0 && (gesture?.phase !== "press" || !gesture)) {
                if (suppressed.current > Date.now()) {
                    event.preventDefault();
                    event.stopImmediatePropagation();
                    suppressed.current = 0;
                }
            }
        };

        controller.current = () => {
            if (!gesture) {
                return;
            }

            if (!latest.current.enabled) {
                cancel();
            } else if (gesture.choice === "drag" && !latest.current.canDrag) {
                if (gesture.phase === "drag") {
                    cancel();
                } else {
                    neutral();
                }
            }
        };

        row.addEventListener("touchstart", start, { passive: true });
        row.addEventListener("contextmenu", context, true);
        row.addEventListener("dragstart", nativeDrag, true);
        row.addEventListener("click", click, true);
        row.addEventListener("pointerdown", fresh, true);
        row.addEventListener("keydown", fresh, true);

        return () => {
            // Activated drags have document listeners in the list-level DnD owner. A tab hover
            // may detach this row; only that owner decides whether navigation cancels the drag.
            if (gesture?.phase === "drag") {
                clearTimeout(timer);

                if (watching) {
                    detach();
                }

                gesture = null;
            } else {
                finish();
            }

            controller.current = null;
            row.removeEventListener("touchstart", start);
            row.removeEventListener("contextmenu", context, true);
            row.removeEventListener("dragstart", nativeDrag, true);
            row.removeEventListener("click", click, true);
            row.removeEventListener("pointerdown", fresh, true);
            row.removeEventListener("keydown", fresh, true);
        };
    }, [ref]);

    useLayoutEffect(() => {
        controller.current?.();
    }, [enabled, canDrag]);

    return {
        hold,
        consumeClick: (event) => {
            if (event?.detail === 0) {
                return false;
            }

            const consumed = suppressed.current > Date.now();

            suppressed.current = 0;

            return consumed;
        },
    };
}
