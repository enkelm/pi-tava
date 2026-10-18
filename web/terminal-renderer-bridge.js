// Display-only bridge for complete, reconstructed terminal presentations. Native protocol
// patches never enter this queue. Each presentation must include all of its image assets.
const MAX_PRESENTATION_BYTES = 32 * 1024 * 1024;
const BOOTSTRAP_DEADLINE_MS = 20_000;
const PAINT_DEADLINE_MS = 10_000;
const LAST_SEQUENCE = 0xffff_ffff;
const ERROR_MESSAGE = "Terminal renderer unavailable.";

/**
 * The caller owns the iframe, message listener and a fresh random session per iframe
 * lifecycle. Pass location.origin verbatim; post must use that exact target origin.
 * Presentations are immutable until sent/replaced. Only the latest waiting object is
 * retained and serialization happens when a transport slot actually opens.
 *
 * gpui-painted acknowledges BOTH gpui-present and gpui-clear. For a presentation it
 * must mean that the child's CPU scene paint completed, not merely that it was parsed.
 */
export function createTerminalRendererBridge({
    source,
    origin,
    session,
    wasmModule,
    post,
    onStatus,
}) {
    let disposed = false;
    let failed = false;
    let transportReady = false;
    let bootstrapped = false;
    let fence = "";
    let sequence = 0;
    let inFlight = null;
    let pending = null;
    let needsClear = false;
    let mayHavePixels = false;
    let deadline = null;
    let status = null;

    function notify(phase) {
        if (status?.phase === phase && status.fence === fence) {
            return;
        }

        status = { phase, fence, ...(phase === "error" ? { message: ERROR_MESSAGE } : {}) };
        onStatus(status);
    }

    function cancelDeadline() {
        if (deadline !== null) {
            clearTimeout(deadline);
            deadline = null;
        }
    }

    function fail() {
        if (disposed || failed) {
            return;
        }

        failed = true;
        pending = null;
        inFlight = null;
        cancelDeadline();
        notify("error");
    }

    function armDeadline(milliseconds) {
        cancelDeadline();
        deadline = setTimeout(fail, milliseconds);
    }

    function send(type, presentation) {
        if (sequence === LAST_SEQUENCE) {
            fail();

            return;
        }

        const message = { type, session, sequence: ++sequence, fence };

        if (type === "gpui-present") {
            try {
                const json = JSON.stringify(presentation);

                if (
                    typeof json !== "string" ||
                    json[0] !== "{" ||
                    json.length > MAX_PRESENTATION_BYTES ||
                    new TextEncoder().encode(json).byteLength > MAX_PRESENTATION_BYTES
                ) {
                    fail();

                    return;
                }

                message.payload = json;
            } catch {
                fail();

                return;
            }
        }

        inFlight = { type, sequence: message.sequence, fence };
        mayHavePixels = type === "gpui-present";
        armDeadline(PAINT_DEADLINE_MS);

        try {
            post(message);
        } catch {
            fail();
        }
    }

    function flush() {
        if (disposed || failed || !transportReady || inFlight) {
            return;
        }

        if (needsClear) {
            needsClear = false;
            send("gpui-clear");
        } else if (pending) {
            const presentation = pending;

            pending = null;
            send("gpui-present", presentation);
        }
    }

    function invalidate() {
        notify("loading");

        if (inFlight?.type === "gpui-clear") {
            // One clear covers all older fences, including changes made while it waits.
            // Never enqueue another clear behind a stalled child.
            return;
        }

        needsClear = true;

        if (transportReady) {
            // A clear is the only command allowed to supersede an outstanding paint.
            // The child cancels older paint callbacks by sequence. No new presentation
            // is sent until this clear is acknowledged, so the wire backlog is bounded
            // by the cancelled paint plus one clear, even during rapid fence changes.
            inFlight = null;
            flush();
        }
    }

    function validFence(value) {
        if (typeof value !== "string") {
            fail();

            return false;
        }

        return true;
    }

    function receive(event) {
        if (disposed || failed || event.origin !== origin) {
            return false;
        }

        const expectedSource = source();

        if (!expectedSource || event.source !== expectedSource) {
            return false;
        }

        const message = event.data;

        if (!message || message.session !== session) {
            return false;
        }

        if (message.type === "gpui-bootstrap") {
            if (bootstrapped || transportReady) {
                return false;
            }

            bootstrapped = true;

            try {
                // Structured-clone the compiled public module; it is NOT transferred or
                // instantiated here. Every child/retry reuses the same download/compilation.
                post({ type: "gpui-bootstrap", session, module: wasmModule });
            } catch {
                fail();
            }

            return true;
        }

        if (message.type === "gpui-ready") {
            if (transportReady) {
                return false;
            }

            transportReady = true;
            cancelDeadline();
            flush();

            return true;
        }

        if (message.type === "gpui-error") {
            // Startup errors need no sequence. A per-paint error must belong to the
            // outstanding command, not a paint cancelled by a later clear.
            if (
                message.sequence !== undefined &&
                (message.sequence !== inFlight?.sequence || message.fence !== inFlight?.fence)
            ) {
                return false;
            }

            fail();

            return true;
        }

        if (
            message.type !== "gpui-painted" ||
            !inFlight ||
            message.sequence !== inFlight.sequence ||
            message.fence !== inFlight.fence
        ) {
            return false;
        }

        const painted = inFlight;

        inFlight = null;
        cancelDeadline();

        if (painted.type === "gpui-present" && painted.fence === fence) {
            notify("ready");
        }

        flush();

        return true;
    }

    function present(presentation, nextFence) {
        if (disposed || failed || !validFence(nextFence)) {
            return false;
        }

        if (!presentation || typeof presentation !== "object" || Array.isArray(presentation)) {
            fail();

            return false;
        }

        if (nextFence !== fence) {
            fence = nextFence;

            if (mayHavePixels) {
                invalidate();
            } else {
                notify("loading");
            }
        }

        pending = presentation;
        flush();

        return !failed;
    }

    function clear(nextFence) {
        if (disposed || failed || !validFence(nextFence)) {
            return false;
        }

        const changed = nextFence !== fence;

        fence = nextFence;
        pending = null;
        notify("loading");

        if (changed || mayHavePixels) {
            invalidate();
        }

        return !failed;
    }

    function dispose() {
        disposed = true;
        pending = null;
        inFlight = null;
        cancelDeadline();
    }

    notify("loading");
    armDeadline(BOOTSTRAP_DEADLINE_MS);

    return { receive, present, clear, dispose };
}
