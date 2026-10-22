// The installed v2 package includes the official React component; Preact compat owns its runtime.
import { useEffect, useState } from "preact/hooks";
import { html } from "./ui.js";

let library;

function loadBlobatar() {
    if (!library) {
        library = import("blobatar/react").then((module) => module.Blobatar);
        library.catch(() => {
            library = undefined;
        });
    }

    return library;
}

/** Decorative identity beside the name. A missing module/image leaves its reserved space quiet. */
export function NamedAgentAvatar({ agentId, size = 28 }) {
    const [Blobatar, setBlobatar] = useState(null);
    const [failed, setFailed] = useState(false);

    useEffect(() => {
        let mounted = true;

        loadBlobatar().then(
            (component) => {
                if (mounted) {
                    setBlobatar(() => component);
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
            Blobatar &&
            !failed &&
            html`<${Blobatar}
                name=${`pip:${agentId}`}
                size=${size}
                alt=""
                aria-hidden="true"
                onError=${() => setFailed(true)}
            />`
        }
    </span>`;
}
