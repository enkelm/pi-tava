// GPUI owns pixels only. The existing TerminalGrid keeps its DOM, transport and input routing.
import { useEffect, useLayoutEffect, useRef, useState } from "preact/hooks";
import { createTerminalRendererBridge } from "./terminal-renderer-bridge.js";
import { loadTerminalRenderer } from "./terminal-renderer-assets.js";

const FAILURE = "Terminal renderer unavailable.";

export function useTerminalRenderer(options) {
    const iframe = useRef(null);
    const bridge = useRef(null);
    const startup = useRef(null);
    const assets = useRef(null);
    const latest = useRef(options);
    const generation = useRef({ key: "", value: 0 });
    const inputContext = useRef({ key: "", painted: false });
    const [attempt, setAttempt] = useState(0);
    const [source, setSource] = useState("");
    const [status, setStatus] = useState({ phase: "loading", fence: "" });
    const [dpr, setDpr] = useState(() =>
        typeof window === "undefined" ? 1 : window.devicePixelRatio || 1,
    );
    const { surface, cw, ch, fontSize, images, selection, theme, themeVersion, inputEpoch } =
        options;
    // Geometry-only repaint barriers hide pixels without retiring acknowledged editor
    // intent. A new session, target or input epoch must earn its own CPU-paint receipt.
    const inputKey = JSON.stringify([
        source,
        attempt,
        options.drawable,
        inputEpoch,
        surface?.boot_id,
        surface?.projection_revision,
        surface?.popup?.terminal_id,
        surface?.panes
            ?.filter((pane) => pane.focused)
            .map((pane) => pane.pane_id)
            .sort(),
    ]);

    if (inputKey !== inputContext.current.key) {
        inputContext.current = { key: inputKey, painted: false };
    }

    const key = JSON.stringify([
        attempt,
        inputEpoch,
        options.drawable,
        surface?.boot_id,
        surface?.projection_revision,
        surface?.frame?.width,
        surface?.frame?.height,
        surface?.popup?.terminal_id,
        surface?.popup?.frame?.width,
        surface?.popup?.frame?.height,
        cw,
        ch,
        fontSize,
        dpr,
        surface?.panes?.map((pane) => [pane.pane_id, pane.focused, pane.rect, pane.inner_rect]),
    ]);

    if (key !== generation.current.key) {
        generation.current = { key, value: generation.current.value + 1 };
    }

    const fence = String(generation.current.value);
    // GPUI owns its backing DPR; reject excessive allocations before mounting/resizing it.
    const fits =
        !options.drawable ||
        Math.ceil(surface.frame.width * cw * dpr) * Math.ceil(surface.frame.height * ch * dpr) <=
            16_000_000;

    latest.current = { ...options, fence };

    const fail = () => {
        inputContext.current.painted = false;
        startup.current?.abort();
        bridge.current?.dispose();
        setSource("");
        setStatus({ phase: "error", fence: latest.current.fence });
        latest.current.report?.(FAILURE);
    };

    const retry = () => {
        // Retire the old child and startup work immediately. The new attempt is also
        // part of the fence, so no receipt can enable input before its own CPU paint.
        inputContext.current.painted = false;
        startup.current?.abort();
        bridge.current?.dispose();
        setSource("");
        setStatus({ phase: "loading", fence: "" });
        setAttempt((value) => value + 1);
    };

    useEffect(() => {
        const update = () => setDpr(window.devicePixelRatio || 1);
        const media = window.matchMedia?.(`(resolution: ${dpr}dppx)`);

        update();
        window.addEventListener("resize", update);
        media?.addEventListener("change", update);

        return () => {
            window.removeEventListener("resize", update);
            media?.removeEventListener("change", update);
        };
    }, [dpr]);

    useLayoutEffect(() => {
        setSource("");

        if (!fits) {
            fail();

            return;
        }

        const controller = new AbortController();

        startup.current = controller;
        setStatus({ phase: "loading", fence: latest.current.fence });
        loadTerminalRenderer({ signal: controller.signal })
            .then((loaded) => {
                if (!controller.signal.aborted) {
                    const random = crypto.getRandomValues(new Uint8Array(16));
                    const session = Array.from(random, (value) =>
                        value.toString(16).padStart(2, "0"),
                    ).join("");

                    assets.current = loaded;
                    setSource(`${loaded.entry}#${session}`);
                }
            })
            .catch(() => {
                if (!controller.signal.aborted) {
                    fail();
                }
            });

        return () => {
            controller.abort();

            if (startup.current === controller) {
                startup.current = null;
            }
        };
    }, [attempt, fits]);

    useLayoutEffect(() => {
        if (!fits || !source || !iframe.current) {
            return;
        }

        let alive = true;
        const node = iframe.current;
        const origin = window.location.origin;
        const session = source.split("#")[1];
        const connection = createTerminalRendererBridge({
            source: () => node.contentWindow,
            origin,
            session,
            wasmModule: assets.current.module,
            post: (message) => node.contentWindow.postMessage(message, origin),
            onStatus: (next) => {
                if (!alive) {
                    return;
                }

                setStatus(next);

                if (next.phase === "error") {
                    fail();
                } else if (
                    next.phase === "ready" &&
                    latest.current.drawable &&
                    next.fence === latest.current.fence
                ) {
                    inputContext.current.painted = true;
                    latest.current.onReady?.(FAILURE);
                }
            },
        });
        const receive = (event) => connection.receive(event);

        bridge.current = connection;
        window.addEventListener("message", receive);

        return () => {
            alive = false;
            connection.dispose();
            window.removeEventListener("message", receive);
            bridge.current = null;
        };
    }, [source, fits]);

    useLayoutEffect(() => {
        const connection = bridge.current;

        if (!fits || !connection) {
            return;
        }

        if (!options.drawable || !surface) {
            connection.clear(fence);

            return;
        }

        connection.present(
            {
                surface,
                images,
                selection: selection && {
                    boot: selection.boot,
                    target: selection.target,
                    anchor: selection.anchor,
                    head: selection.head,
                },
                metrics: { cw, ch, fontSize },
                theme,
            },
            fence,
        );
    }, [
        source,
        options.drawable,
        fits,
        surface,
        images,
        selection,
        cw,
        ch,
        fontSize,
        themeVersion,
        inputEpoch,
        fence,
    ]);

    const error = !fits || status.phase === "error";
    const active =
        !error &&
        !!source &&
        !!options.drawable &&
        status.phase === "ready" &&
        status.fence === fence;

    return {
        iframe,
        source: error ? "" : source,
        active,
        inputReady: !error && !!source && !!options.drawable && inputContext.current.painted,
        loading: !error && !!options.drawable && !active,
        error,
        retry,
    };
}
