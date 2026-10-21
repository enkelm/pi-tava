// Thread type is independent of placement; legacy sessions are Workers.
import { html, Icon } from "./ui.js";
import { store } from "./store.js";

/** The role name for navigation controls, using the same labels as the visual indicators. */
export function threadTypeLabel(session) {
    if (session?.workSupervisor) {
        return "PiP";
    }

    const type = session?.threadType ?? "worker";

    return store.state.server?.agentProfiles?.find((profile) => profile.id === type)?.name ?? type;
}

export function AgentProfileTag({ profile, iconOnly = false }) {
    return html`<${ThreadTypeTag} session=${{ threadType: profile }} iconOnly=${iconOnly} />`;
}

export function ThreadTypeTag({ session, iconOnly = false }) {
    const type = session?.threadType ?? "worker";
    const label = threadTypeLabel(session);
    const icon = session?.workSupervisor
        ? "pip"
        : (store.state.server?.agentProfiles?.find((profile) => profile.id === type)?.icon ??
          "bot");

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
