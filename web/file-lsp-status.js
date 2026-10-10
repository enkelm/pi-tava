// The owner's editor status menu reads the daemon's pool without starting or retaining servers.
import { useEffect, useId, useRef, useState } from "preact/hooks";
import { useBack } from "./back.js";
import { api } from "./store.js";
import { anchorStyle, html, Icon, Loader, popAnchor } from "./ui.js";

const states = { starting: "Starting", running: "Running", idle: "Idle" };

function projectPath(uri) {
    try {
        return decodeURIComponent(new URL(uri).pathname).replace(/\/$/, "");
    } catch {
        return uri || "Unknown project";
    }
}

export function FileLspStatus({ conversation, owner, state, name, detail }) {
    const id = useId();
    const trigger = useRef(null);
    const menu = useRef(null);
    const [open, setOpen] = useState(false);
    const [anchor, setAnchor] = useState(null);
    const [servers, setServers] = useState(null);
    const [error, setError] = useState(null);

    const close = () => {
        setOpen(false);
        trigger.current?.focus({ preventScroll: true });
    };

    useBack(open && owner, close);
    useEffect(() => {
        if (!open || !owner) {
            if (!owner && open) {
                setOpen(false);
            }

            setServers(null);
            setError(null);

            return;
        }

        let live = true;
        let pending = false;
        const abort = new AbortController();
        const place = () => setAnchor(popAnchor(`[id="${id}"]`));

        const refresh = async () => {
            if (pending) {
                return;
            }

            pending = true;

            try {
                const result = await api(
                    `c/${conversation}/lsp`,
                    { action: "status" },
                    { signal: abort.signal },
                );

                if (live) {
                    if (!Array.isArray(result.servers)) {
                        throw new Error("Restart the daemon to enable language-server status.");
                    }

                    setServers(result.servers);
                    setError(null);
                }
            } catch (failure) {
                if (live) {
                    setServers(null);
                    setError(
                        failure.status === 400
                            ? "Restart the daemon to enable language-server status."
                            : failure.message,
                    );
                }
            } finally {
                pending = false;
            }
        };

        const outside = (event) => {
            if (!menu.current?.contains(event.target) && !trigger.current?.contains(event.target)) {
                // An outside click keeps its intended focus instead of returning to the chip.
                setOpen(false);
            }
        };

        const key = (event) => {
            if (event.key === "Escape") {
                event.preventDefault();
                event.stopPropagation();
                close();
            }
        };

        place();
        menu.current?.focus({ preventScroll: true });
        refresh();
        const timer = setInterval(refresh, 2000);
        const observer = new ResizeObserver(place);
        const footer = trigger.current?.closest(".file-edit-footer");

        if (footer) {
            observer.observe(footer);
        }

        document.addEventListener("pointerdown", outside, true);
        window.addEventListener("keydown", key, true);
        window.addEventListener("resize", place);
        visualViewport?.addEventListener("resize", place);

        return () => {
            live = false;
            abort.abort();
            clearInterval(timer);
            observer.disconnect();
            document.removeEventListener("pointerdown", outside, true);
            window.removeEventListener("keydown", key, true);
            window.removeEventListener("resize", place);
            visualViewport?.removeEventListener("resize", place);
        };
    }, [open, owner, conversation, id]);

    if (!owner) {
        return html`<span class="file-edit-lsp-local" title=${detail}>Local editing</span>`;
    }

    return html`<button
        id=${id}
        ref=${trigger}
        type="button"
        class=${`file-edit-lsp-chip state-${state}`}
        title=${detail}
        aria-label="Language server status"
        aria-haspopup="dialog"
        aria-expanded=${open}
        aria-controls=${open ? `${id}-menu` : undefined}
        onClick=${() => setOpen(!open)}
    >
        <span class="file-edit-status-dot" aria-hidden="true"></span>
        ${name}
        <${Icon} name="down" size=${12} />
    </button>
    ${
        open &&
        html`<section
        id=${`${id}-menu`}
        ref=${menu}
        class=${`pop-menu file-lsp-menu ${anchor ? "" : "free"}`}
        style=${anchorStyle(anchor)}
        role="dialog"
        aria-label="Language servers"
        tabindex="-1"
    >
        <header class="pop-menu-head">
            <span>Language servers</span>
            <button
                class="icon-button"
                type="button"
                aria-label="Close language server status"
                onClick=${close}
            >
                <${Icon} name="close" size=${16} />
            </button>
        </header>
        <p class="file-lsp-detail">${detail}</p>
        ${error && html`<p class="file-lsp-error" role="alert">${error}</p>`}
        ${!servers && !error && html`<${Loader} label="Loading servers" />`}
        ${servers?.length === 0 && html`<p class="file-lsp-detail">No active language servers.</p>`}
        ${
            servers?.length > 0 &&
            html`<ul class="file-lsp-servers">
            ${servers.map((server) => {
                const path = projectPath(server.rootUri);
                const project = path.split("/").pop() || path;

                return html`<li class="file-lsp-server" key=${server.id}>
                    <div class="file-lsp-server-head">
                        <strong>${server.name}</strong>
                        <span class=${`file-lsp-server-state state-${server.status}`}>
                            ${states[server.status] || "Unknown"}
                        </span>
                    </div>
                    <div class="file-lsp-project">
                        <span title=${path}>${project}</span>
                        <span>${server.documents} ${server.documents === 1 ? "document" : "documents"}</span>
                    </div>
                </li>`;
            })}
        </ul>`
        }
        <p class="file-lsp-detail">Servers are reused per project and stop when idle.</p>
    </section>`
    }`;
}
