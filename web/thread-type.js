// Thread type is independent of placement; legacy sessions are Workers.
import { html, Icon } from "./ui.js";

const TYPES = {
    worker: { label: "Worker", icon: "bot" },
    chat: { label: "Chat", icon: "chat" },
    reviewer: { label: "Reviewer", icon: "search" },
    land: { label: "Land", icon: "fork" },
    publish: { label: "Publish", icon: "external" },
};

/** The role name for navigation controls, using the same labels as the visual indicators. */
export function threadTypeLabel(session) {
    return TYPES[session?.threadType]?.label ?? TYPES.worker.label;
}

export function ThreadTypeTag({ session, iconOnly = false }) {
    const type = TYPES[session?.threadType] ? session.threadType : "worker";
    const { label, icon } = TYPES[type];

    return html`<span
        class=${`thread-type ${type} ${iconOnly ? "icon-only" : ""}`}
        role=${iconOnly ? "img" : undefined}
        aria-label=${iconOnly ? label : undefined}
        title=${label}
    >
        <${Icon} name=${icon} size=${iconOnly ? 14 : 12} />
        ${!iconOnly && label}
    </span>`;
}
