// Public renderer code only. No terminal connection, content, GPU window or WASM instance.
const ROOT = "/herdr-renderer/";
const MAX_WASM_BYTES = 64 * 1024 * 1024;
const revisions = new Map();
let manifestRequest = null;

function bounded(work, milliseconds) {
    const controller = new AbortController();
    let timeout;
    const expired = new Promise((_, reject) => {
        timeout = setTimeout(() => {
            controller.abort();
            reject(new Error("Renderer loading timed out"));
        }, milliseconds);
    });

    return Promise.race([work(controller.signal), expired]).finally(() => clearTimeout(timeout));
}

function manifest() {
    // Share concurrent checks, not a settled manifest: entry/retry must see a new build.
    if (!manifestRequest) {
        manifestRequest = bounded(async (signal) => {
            const response = await fetch(`${ROOT}build.json`, { cache: "no-store", signal });

            if (!response.ok) {
                throw new Error("Renderer build unavailable");
            }

            const value = await response.json();

            if (
                value.schema !== 2 ||
                value.kind !== "live-terminal" ||
                typeof value.entry !== "string" ||
                !/^[a-f0-9]{16}\/index\.html$/.test(value.entry)
            ) {
                throw new Error("Renderer build incompatible");
            }

            return `${ROOT}${value.entry}`;
        }, 15_000).finally(() => {
            manifestRequest = null;
        });
    }

    return manifestRequest;
}

async function compile(entry, background) {
    const base = entry.slice(0, -"index.html".length);
    const module = await bounded(async (signal) => {
        const response = await fetch(`${base}pkg/herdr_renderer_bg.wasm`, {
            credentials: "same-origin",
            cache: "default",
            priority: background ? "low" : "auto",
            signal,
        });

        if (!response.ok || Number(response.headers.get("content-length")) > MAX_WASM_BYTES) {
            throw new Error("Renderer assets unavailable");
        }

        if (
            typeof WebAssembly.compileStreaming === "function" &&
            response.headers.get("content-type")?.split(";")[0].trim() === "application/wasm"
        ) {
            return WebAssembly.compileStreaming(response);
        }

        // Older running servers may still serve octet-stream until the owner restarts.
        // Consume the SAME response, not a second request or a streaming retry.
        const bytes = await response.arrayBuffer();

        if (bytes.byteLength > MAX_WASM_BYTES) {
            throw new Error("Renderer assets exceed limits");
        }

        return WebAssembly.compile(bytes);
    }, 120_000);

    return { entry, module };
}

function cancelled(signal) {
    return signal.reason ?? new DOMException("Renderer loading cancelled", "AbortError");
}

/** Share one download/compilation per revision. Caller cancellation never cancels another mount. */
export async function loadTerminalRenderer({ signal, background = false } = {}) {
    if (signal?.aborted) {
        throw cancelled(signal);
    }

    const loading = manifest().then((entry) => {
        let assets = revisions.get(entry);

        if (!assets) {
            assets = compile(entry, background).catch((error) => {
                if (revisions.get(entry) === assets) {
                    revisions.delete(entry);
                }

                throw error;
            });
            revisions.set(entry, assets);

            // A page normally uses one build. Bound retained modules during repeated rebuilds;
            // existing consumers keep their own reference to any retired revision.
            if (revisions.size > 2) {
                revisions.delete(revisions.keys().next().value);
            }
        }

        return assets;
    });

    if (!signal) {
        return loading;
    }

    return new Promise((resolve, reject) => {
        const abort = () => reject(cancelled(signal));

        signal.addEventListener("abort", abort, { once: true });
        loading.then(resolve, reject).finally(() => signal.removeEventListener("abort", abort));

        if (signal.aborted) {
            abort();
        }
    });
}

/** App startup calls this once. Idle prefetch never blocks boot or opens a hidden renderer. */
export function startTerminalRendererPrefetch(store) {
    let attempted = null;
    let scheduled = null;
    let departed = false;
    const owner = () => (store.state.me?.role === "owner" ? store.state.me.id : null);
    const eligible = () =>
        !departed && owner() && document.visibilityState !== "hidden" && navigator.onLine !== false;

    const cancel = () => {
        scheduled?.();
        scheduled = null;
    };

    const update = () => {
        if (!eligible() || attempted === owner()) {
            cancel();

            return;
        }

        if (scheduled) {
            return;
        }

        const run = () => {
            scheduled = null;

            if (eligible()) {
                attempted = owner();
                // Only public immutable code finishes after hide/sign-out, so a foreground
                // mount can share it. No content, credentials or private renderer state is kept.
                loadTerminalRenderer({ background: true }).catch(() => {});
            }
        };

        if (typeof window.requestIdleCallback === "function") {
            const id = window.requestIdleCallback(run, { timeout: 5_000 });

            scheduled = () => window.cancelIdleCallback(id);
        } else {
            const id = setTimeout(run, 500);

            scheduled = () => clearTimeout(id);
        }
    };

    const hide = () => {
        departed = true;
        cancel();
    };

    const show = () => {
        departed = false;
        update();
    };

    const unsubscribe = store.subscribe(update);

    document.addEventListener("visibilitychange", update);
    window.addEventListener("online", update);
    window.addEventListener("offline", update);
    window.addEventListener("pagehide", hide);
    window.addEventListener("pageshow", show);
    update();

    return () => {
        hide();
        unsubscribe();
        document.removeEventListener("visibilitychange", update);
        window.removeEventListener("online", update);
        window.removeEventListener("offline", update);
        window.removeEventListener("pagehide", hide);
        window.removeEventListener("pageshow", show);
    };
}
