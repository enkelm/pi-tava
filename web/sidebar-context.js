// Sidebar-owned context menus leave text fields, selected text and the rest of the web app alone.
import { useEffect, useRef } from "preact/hooks";
import { openSheet, store } from "./store.js";

export function openSidebarOptions(kind, id, at, { keepDrawer = false, userId, chatId } = {}) {
    const sheet = { type: "sidebar-options", kind, id, at };

    if (userId !== undefined) {
        sheet.userId = userId;
    }

    if (chatId !== undefined) {
        sheet.chatId = chatId;
    }

    if (keepDrawer) {
        // Select must still address the source list, as the legacy held-row sheet does.
        store.set({ sheet });
    } else {
        openSheet(sheet);
    }
}

/** A menu can unmount its source drawer before lift. Keep that contact from acting on the new sheet. */
export function consumeHeldContact({ identifier, source }) {
    const seen = new WeakSet();
    let lifted = false;
    let timer = 0;
    const types = ["touchmove", "touchend", "touchcancel"];

    const dispose = () => {
        clearTimeout(timer);

        for (const type of types) {
            document.removeEventListener(type, track, true);
            source?.removeEventListener(type, track, true);
        }

        document.removeEventListener("click", click, true);
        document.removeEventListener("pointerdown", fresh, true);
        document.removeEventListener("touchstart", fresh, true);
        document.removeEventListener("keydown", key, true);
        document.removeEventListener("visibilitychange", visibility);
        removeEventListener("blur", dispose);
    };

    const track = (event) => {
        if (seen.has(event) || lifted) {
            return;
        }

        seen.add(event);
        const touches = event.type === "touchmove" ? event.touches : event.changedTouches;

        if (![...touches].some((touch) => touch.identifier === identifier)) {
            return;
        }

        if (event.cancelable) {
            event.preventDefault();
        }

        if (event.type !== "touchmove") {
            lifted = true;
            clearTimeout(timer);
            timer = setTimeout(dispose, 800);
        }
    };

    const click = (event) => {
        if (event.detail > 0) {
            event.preventDefault();
            event.stopImmediatePropagation();
            dispose();
        }
    };

    const fresh = () => dispose();

    const key = () => {
        if (lifted) {
            dispose();
        }
    };

    const visibility = () => document.hidden && dispose();

    for (const type of types) {
        document.addEventListener(type, track, { capture: true, passive: false });
        source?.addEventListener(type, track, { capture: true, passive: false });
    }

    document.addEventListener("click", click, true);
    document.addEventListener("pointerdown", fresh, true);
    document.addEventListener("touchstart", fresh, true);
    document.addEventListener("keydown", key, true);
    document.addEventListener("visibilitychange", visibility);
    addEventListener("blur", dispose);
    // Lost browser contact without touchcancel must not leave a permanent listener behind.
    timer = setTimeout(dispose, 30_000);
}

/** Right-click and keyboard access everywhere; opted-in sidebar surfaces also have a simple touch hold. */
export function useSidebarContext(ref, onOpen, { longPress = false, enabled = true } = {}) {
    const latest = useRef(onOpen);

    latest.current = onOpen;
    useEffect(() => {
        const element = ref.current;

        if (!element || !enabled) {
            return undefined;
        }

        let timer = 0;
        let contact = null;
        let suppressUntil = 0;
        let touchedUntil = 0;

        const cancel = () => {
            clearTimeout(timer);
            timer = 0;
            contact = null;
            document.removeEventListener("scroll", cancel, true);
            document.removeEventListener("touchstart", second, true);
            document.removeEventListener("visibilitychange", cancel);
        };

        const second = (event) => {
            if (event.touches.length !== 1) {
                cancel();
            }
        };

        const context = (event) => {
            if (
                event.target.closest("input, textarea, select, [contenteditable]") ||
                getSelection()?.toString()
            ) {
                return;
            }

            event.preventDefault();
            event.stopPropagation();
            cancel();

            const touch = event.pointerType
                ? event.pointerType === "touch"
                : (event.sourceCapabilities?.firesTouchEvents ??
                  (event.button !== 2 && Date.now() < touchedUntil));

            // Thread holds have their own slide-to-choose gate; a native callout must not skip it.
            if (Date.now() >= suppressUntil && (longPress || !touch)) {
                latest.current({ x: event.clientX, y: event.clientY, touch });
            }
        };

        const key = (event) => {
            if (
                (event.key !== "ContextMenu" && !(event.shiftKey && event.key === "F10")) ||
                event.defaultPrevented ||
                event.isComposing ||
                event.keyCode === 229 ||
                event.target.closest("input, textarea, select, [contenteditable]") ||
                getSelection()?.toString()
            ) {
                return;
            }

            event.preventDefault();
            event.stopPropagation();
            cancel();
            const rect = event.target.getBoundingClientRect();

            latest.current({ x: rect.left + 16, y: rect.bottom, keyboard: true });
        };

        const start = (event) => {
            cancel();

            const control = event.target.closest("button:not(.group-head), a");

            if (
                event.touches.length !== 1 ||
                (control && control !== element) ||
                event.target.closest("input, textarea, select, [contenteditable]") ||
                getSelection()?.toString()
            ) {
                return;
            }

            const finger = event.touches[0];

            contact = {
                id: finger.identifier,
                x: finger.clientX,
                y: finger.clientY,
                source: event.target,
            };
            document.addEventListener("scroll", cancel, { capture: true, passive: true });
            document.addEventListener("touchstart", second, { capture: true, passive: true });
            document.addEventListener("visibilitychange", cancel);
            timer = setTimeout(() => {
                if (!contact) {
                    return;
                }

                suppressUntil = Date.now() + 800;
                consumeHeldContact({ identifier: contact.id, source: contact.source });
                latest.current({ x: contact.x, y: contact.y, touch: true });
                cancel();
            }, 450);
        };

        const move = (event) => {
            const finger =
                contact && [...event.touches].find((each) => each.identifier === contact.id);

            if (
                !finger ||
                event.touches.length !== 1 ||
                Math.hypot(finger.clientX - contact.x, finger.clientY - contact.y) > 8
            ) {
                cancel();
            }
        };

        const touchStart = (event) => {
            touchedUntil = Date.now() + 2000;

            if (longPress) {
                start(event);
            }
        };

        element.addEventListener("contextmenu", context);
        element.addEventListener("keydown", key);
        element.addEventListener("touchstart", touchStart, { passive: true });

        if (longPress) {
            element.addEventListener("touchmove", move, { passive: true });
            element.addEventListener("touchend", cancel);
            element.addEventListener("touchcancel", cancel);
            addEventListener("blur", cancel);
        }

        return () => {
            cancel();
            element.removeEventListener("contextmenu", context);
            element.removeEventListener("keydown", key);
            element.removeEventListener("touchstart", touchStart);
            element.removeEventListener("touchmove", move);
            element.removeEventListener("touchend", cancel);
            element.removeEventListener("touchcancel", cancel);
            removeEventListener("blur", cancel);
        };
    }, [longPress, enabled]);
}
