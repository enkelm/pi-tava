// Thread type is independent of its project or goal; legacy sessions are Workers.
import { html, Icon } from "./ui.js";

export function ThreadTypeTag({ session, iconOnly = false }) {
    const worker = (session?.threadType ?? "worker") === "worker";
    const label = worker ? "Worker" : "Chat";

    return html`<span
        class=${`thread-type ${worker ? "worker" : "chat"} ${iconOnly ? "icon-only" : ""}`}
        role=${iconOnly ? "img" : undefined}
        aria-label=${iconOnly ? label : undefined}
        title=${label}
    >
        <${Icon} name=${worker ? "bot" : "chat"} size=${iconOnly ? 14 : 12} />
        ${!iconOnly && label}
    </span>`;
}
