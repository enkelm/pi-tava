// One elapsed-label clock shared by mounted live UI, never a source of agent state or refreshes.
import { useEffect, useState } from "preact/hooks";

const listeners = new Set();
let timer = null;
let departed = false;

const awake = () => !departed && document.visibilityState !== "hidden";

function stop() {
    const previous = timer;

    timer = null;

    if (previous !== null) {
        clearInterval(previous.id);
    }
}

/** Fence even an already queued callback from an interval cancelled before a hide/return. */
function publish(current) {
    for (const listener of [...listeners]) {
        if (timer !== current || !awake()) {
            return;
        }

        if (listeners.has(listener)) {
            listener();
        }
    }
}

function sync() {
    if (listeners.size === 0 || !awake()) {
        stop();

        return;
    }

    if (timer !== null) {
        return;
    }

    const current = { id: null };

    timer = current;
    current.id = setInterval(() => publish(current), 1000);
    // Resume from Date.now() without waiting for a tick. The hook's counter keeps a rapid hide/show
    // observable even when Preact batches it into a single render.
    publish(current);
}

function hide() {
    departed = true;
    sync();
}

function show() {
    departed = false;

    if (listeners.size === 0) {
        window.removeEventListener("pageshow", show);
    }

    sync();
}

function subscribe(listener) {
    listeners.add(listener);

    if (listeners.size === 1) {
        document.addEventListener("visibilitychange", sync);
        window.addEventListener("pagehide", hide);
        window.addEventListener("pageshow", show);
    }

    sync();

    return () => {
        listeners.delete(listener);

        if (listeners.size !== 0) {
            return;
        }

        stop();
        document.removeEventListener("visibilitychange", sync);
        window.removeEventListener("pagehide", hide);

        // Keep only this passive return listener if the last subscriber leaves during departure.
        // It releases the latch even with no UI left; a new subscriber before then stays paused.
        if (!departed) {
            window.removeEventListener("pageshow", show);
        }
    };
}

/** Tick live, visible elapsed labels; consumers still calculate from real timestamps. */
export function useVisibleClock(active) {
    const [, tick] = useState(0);

    useEffect(() => {
        if (active) {
            return subscribe(() => tick((count) => count + 1));
        }
    }, [active]);
}
