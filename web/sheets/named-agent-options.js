// Identity actions use the right-clicked catalogue entry, never the currently selected chat.
import { openAgentDraft } from "../agent-drafts.js";
import { namedAgentsAvailable, openAgentSettings } from "../named-agents.js";
import { openSheet, store } from "../store.js";
import { html, Icon } from "../ui.js";
import { OptionsSurface } from "./sidebar-options.js";

const NARROW = matchMedia("(max-width: 699px)");
const memoryEnabled = () => store.state.server?.extensions?.includes("pocket-memory") === true;

export function NamedAgentOptions({ sheet }) {
    const { id, userId, at } = sheet;
    const current = () =>
        store.state.sheet === sheet &&
        store.state.me?.id === userId &&
        namedAgentsAvailable() &&
        (store.state.namedAgents ?? []).some((agent) => agent.agentId === id);
    const agent = current() ? store.state.namedAgents.find((agent) => agent.agentId === id) : null;
    // Match SidebarOptions: narrow mouse/keyboard requests stay anchored, only touch uses a sheet.
    const bottom = NARROW.matches && !at?.keyboard && (!at || at.touch);
    const items = [
        {
            label: "New chat",
            icon: "plus",
            run: () => {
                store.set({ sidebarTab: "sessions" });
                openAgentDraft(id);
            },
        },
        {
            label: "Memory",
            icon: "brain",
            disabled: !memoryEnabled(),
            title: memoryEnabled()
                ? undefined
                : "Enable Memory in Extensions to use this agent's memory",
            run: () => {
                if (memoryEnabled()) {
                    openSheet({ type: "memory", conversationId: `agent:${id}` });
                }
            },
        },
        {
            label: "Rename…",
            icon: "pencil",
            run: () => openAgentSettings(null, id, "name"),
        },
        {
            label: "Agent settings…",
            icon: "settings",
            run: () => openAgentSettings(null, id),
        },
    ];

    return html`<${OptionsSurface} title=${agent?.name ?? "PiP options"} at=${at} bottom=${bottom}>
        ${!agent && html`<p class="muted small">This agent is no longer available.</p>`}
        ${
            agent &&
            items.map(
                (item) => html`<button
                    class="sidebar-option"
                    role=${bottom ? undefined : "menuitem"}
                    tabindex=${bottom ? undefined : -1}
                    disabled=${item.disabled}
                    title=${item.title}
                    onClick=${() => {
                        if (current()) {
                            item.run();
                        }
                    }}
                >
                    <${Icon} name=${item.icon} size=${16} />
                    <span>${item.label}</span>
                </button>`,
            )
        }
    <//>`;
}
