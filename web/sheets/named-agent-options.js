// Identity actions use the right-clicked catalogue entry, never the currently selected chat.
import { openAgentDraft } from "../agent-drafts.js";
import { namedAgentsAvailable, openAgentSettings } from "../named-agents.js";
import { isUnread, openSheet, setUnread, store } from "../store.js";
import { canMoveSessions } from "../session-moves.js";
import { isPinned, togglePin } from "../theme.js";
import { html, Icon } from "../ui.js";
import { OptionsSurface } from "./sidebar-options.js";

const NARROW = matchMedia("(max-width: 699px)");
const memoryEnabled = () => store.state.server?.extensions?.includes("pocket-memory") === true;

export function NamedAgentOptions({ sheet }) {
    const { id, userId, at, chatId } = sheet;
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

    const currentChat = () =>
        store.state.namedAgents
            ?.find((identity) => identity.agentId === id)
            ?.chats?.find((chat) => chat.id === chatId);
    const chat = agent?.chats?.find((chat) => chat.id === chatId);

    if (chat && !chat.archived) {
        items.push(
            {
                label: isPinned(chatId) ? "Unpin" : "Pin to the top",
                icon: "pin",
                run: () => {
                    const source = currentChat();

                    if (source && !source.archived) {
                        togglePin(chatId);
                    }
                },
            },
            {
                label: isUnread(chatId) ? "Mark read" : "Mark unread",
                icon: "unread",
                run: () => {
                    const source = currentChat();

                    if (source && !source.archived) {
                        setUnread(chatId, !isUnread(chatId));
                    }
                },
            },
        );
    }

    if (canMoveSessions() && chat) {
        items.push({
            label: "Move Chat to project…",
            icon: "folder",
            run: () => {
                if (canMoveSessions() && currentChat()) {
                    openSheet({ type: "move-sessions", ids: [chatId] });
                }
            },
        });
    }

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
