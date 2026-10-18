// Paint-only host. No socket, terminal input, storage, controls or generated content.
const session = location.hash.slice(1);
const origin = location.origin;
const MAX_PAYLOAD = 32 * 1024 * 1024;
let wasm;
let current = null;
let failed = false;
let disposed = false;
let ready = false;
let receiveBootstrap;

function retireBootstrap() {
    receiveBootstrap?.(null);
    receiveBootstrap = null;
}

function send(type, fields = {}) {
    if (!disposed && /^[a-f0-9]{32}$/.test(session)) {
        parent.postMessage({ type, session, ...fields }, origin);
    }
}

function fail() {
    if (failed || disposed) {
        return;
    }

    failed = true;
    ready = false;
    current = null;
    retireBootstrap();
    // Do not forward exceptions: parser/backend errors must never export terminal content.
    send("gpui-error", { message: "Terminal renderer unavailable." });
}

function painted(sequence) {
    if (!failed && !disposed && ready && current?.sequence === sequence) {
        send("gpui-painted", { sequence, fence: current.fence });
    }
}

window.addEventListener("message", (event) => {
    const message = event.data;

    if (
        event.source !== parent ||
        event.origin !== origin ||
        message?.session !== session ||
        failed ||
        disposed
    ) {
        return;
    }

    if (message.type === "gpui-bootstrap") {
        if (receiveBootstrap) {
            if (!(message.module instanceof WebAssembly.Module)) {
                fail();

                return;
            }

            receiveBootstrap(message.module);
            receiveBootstrap = null;
        }

        return;
    }

    if (!ready) {
        return;
    }

    try {
        if (
            message.type === "gpui-clear" &&
            Number.isInteger(message.sequence) &&
            message.sequence > 0 &&
            message.sequence <= 0xffff_ffff &&
            typeof message.fence === "string"
        ) {
            current = { sequence: message.sequence, fence: message.fence };
            wasm.clear(message.sequence);
        } else if (
            message.type === "gpui-present" &&
            Number.isInteger(message.sequence) &&
            message.sequence > 0 &&
            message.sequence <= 0xffff_ffff &&
            typeof message.fence === "string" &&
            typeof message.payload === "string" &&
            message.payload.length <= MAX_PAYLOAD
        ) {
            current = { sequence: message.sequence, fence: message.fence };
            wasm.present(message.payload, message.sequence);
        }
    } catch {
        fail();
    }
});
window.addEventListener("error", fail);
window.addEventListener("unhandledrejection", fail);
window.addEventListener("pagehide", () => {
    disposed = true;
    ready = false;
    current = null;
    retireBootstrap();
    observer.disconnect();
});

// GPUI reports asynchronous GPU setup failures with a paragraph rather than a thrown error.
const observer = new MutationObserver((records) => {
    for (const record of records) {
        for (const node of record.addedNodes) {
            if (
                node instanceof HTMLParagraphElement &&
                node.textContent.startsWith("Failed to initialize browser graphics:")
            ) {
                fail();
                node.remove();
            }
        }
    }
});

observer.observe(document.body, { childList: true });

async function start() {
    if (!/^[a-f0-9]{32}$/.test(session) || parent === window) {
        return;
    }

    const bootstrap = new Promise((resolve) => {
        receiveBootstrap = resolve;
    });

    // The parent owns the one revision-scoped download/compilation. Import only bindings
    // here; a compiled Module is structured-cloned, not transferred or initialized there.
    send("gpui-bootstrap");
    const [module, compiledModule] = await Promise.all([
        import("./pkg/herdr_renderer.js"),
        bootstrap,
    ]);

    if (disposed || failed) {
        return;
    }

    wasm = module;
    await wasm.default({ module_or_path: compiledModule });

    if (disposed || failed) {
        return;
    }

    wasm.start(
        painted,
        () => {
            if (disposed || failed || ready) {
                return;
            }

            ready = true;
            send("gpui-ready");
        },
        fail,
    );
}

start().catch(fail);
