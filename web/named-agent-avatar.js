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
                animate=${animated ? "always" : undefined}
                expression=${thinking ? loaded.thinking : loaded.idle}
                size=${size}
                alt=""
                aria-hidden="true"
                onError=${() => setFailed(true)}
            />`
        }
    </span>`;
}
