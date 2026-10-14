// One-finger terminal intent: swipe scrolls; a deliberate hold starts local selection.
// Target context is checked at the timer and every continuation; no gesture survives a reset.
const HOLD_MS = 450;
const SLOP_PX = 10;

export function terminalTouch({
    context,
    onStart,
    onTap,
    onScroll,
    onSelectionStart,
    onSelectionMove,
    onSelectionEnd,
    onCancel,
}) {
    const contacts = new Set();
    let gesture = null;

    const stop = () => {
        const previous = gesture;

        gesture = null;
        clearTimeout(previous?.timer);

        if (previous) {
            onCancel?.(previous.mode);
        }
    };

    const sync = () => {
        if (gesture && context(gesture.target) !== gesture.context) {
            stop();
        }

        return gesture;
    };

    return {
        start(event, target) {
            if (contacts.has(event.pointerId) || contacts.size >= 16) {
                return false;
            }

            if (contacts.size) {
                contacts.add(event.pointerId);
                stop();

                return false;
            }

            if (onStart?.({ event, target }) === false) {
                return false;
            }

            contacts.add(event.pointerId);
            const pending = {
                pointerId: event.pointerId,
                target,
                context: context(target),
                origin: event,
                lastX: event.clientX,
                lastY: event.clientY,
                mode: "pending",
                timer: null,
            };

            gesture = pending;
            pending.timer = setTimeout(() => {
                if (sync() !== pending || pending.mode !== "pending") {
                    return;
                }

                pending.mode = "select";
                onSelectionStart({ event: pending.origin, target: pending.target });
            }, HOLD_MS);

            return true;
        },
        move(event) {
            const current = sync();

            if (!current || current.pointerId !== event.pointerId) {
                return;
            }

            if (current.mode === "pending") {
                if (
                    Math.hypot(
                        event.clientX - current.origin.clientX,
                        event.clientY - current.origin.clientY,
                    ) <= SLOP_PX
                ) {
                    return;
                }

                clearTimeout(current.timer);
                current.mode = "scroll";
            }

            if (current.mode === "select") {
                onSelectionMove({ event, target: current.target });
            } else {
                const dx = current.lastX - event.clientX;
                const dy = current.lastY - event.clientY;

                if (dx || dy) {
                    onScroll({ event, target: current.target, dx, dy });
                }
            }

            current.lastX = event.clientX;
            current.lastY = event.clientY;
        },
        end(event) {
            // A final movement can arrive only with pointerup (especially on Safari).
            this.move(event);
            const current = sync();

            contacts.delete(event.pointerId);

            if (!current || current.pointerId !== event.pointerId) {
                return;
            }

            gesture = null;
            clearTimeout(current.timer);

            if (current.mode === "pending") {
                onTap({ event, target: current.target });
            } else if (current.mode === "select") {
                onSelectionEnd({ event, target: current.target });
            }
        },
        cancel(pointerId) {
            if (pointerId === undefined) {
                contacts.clear();
                stop();
            } else {
                contacts.delete(pointerId);

                if (gesture?.pointerId === pointerId) {
                    stop();
                }
            }
        },
        sync,
    };
}
