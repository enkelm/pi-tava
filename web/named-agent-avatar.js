// The installed v2 package includes the official React component; Preact compat owns its runtime.
import { useEffect, useState } from "preact/hooks";
import { html } from "./ui.js";

let library;

function loadBlobatar() {
    if (!library) {
        library = Promise.all([import("blobatar/react"), import("blobatar/expression")]).then(
            ([{ Blobatar }, { thinking, idle }]) => ({ Blobatar, thinking, idle }),
        );
        library.catch(() => {
            library = undefined;
        });
    }

    return library;
}

/** Decorative identity beside the name. A missing module/image leaves its reserved space quiet. */
export function NamedAgentAvatar({ agentId, size = 28, animated = false, thinking = false }) {
    const [loaded, setLoaded] = useState(null);
    const [failed, setFailed] = useState(false);
    const [visible, setVisible] = useState(() => document.visibilityState !== "hidden");

    useEffect(() => {
        let departed = false;
        const update = () => setVisible(!departed && document.visibilityState !== "hidden");

        const hide = () => {
            departed = true;
            update();
        };

        const show = () => {
            departed = false;
            update();
        };

        document.addEventListener("visibilitychange", update);
        addEventListener("pagehide", hide);
        addEventListener("pageshow", show);
        update();

        return () => {
            document.removeEventListener("visibilitychange", update);
            removeEventListener("pagehide", hide);
            removeEventListener("pageshow", show);
        };
    }, []);

    useEffect(() => {
        let mounted = true;

        loadBlobatar().then(
            (module) => {
                if (mounted) {
                    setLoaded(module);
                }
            },
            () => {
                if (mounted) {
                    setFailed(true);
                }
            },
        );

        return () => {
            mounted = false;
        };
    }, []);

    // Idle/hidden identities use Blobatar's single-image path, not ambient SVG loops.
    return html`<span
        class="named-agent-avatar"
        aria-hidden="true"
        style=${{ width: size, height: size }}
    >
        ${
            loaded &&
            !failed &&
            html`<${loaded.Blobatar}
                name=${`pip:${agentId}`}
                animate=${animated && thinking && visible ? "always" : undefined}
                expression=${thinking ? loaded.thinking : loaded.idle}
                size=${size}
                alt=""
                aria-hidden="true"
                onError=${() => setFailed(true)}
            />`
        }
    </span>`;
}
