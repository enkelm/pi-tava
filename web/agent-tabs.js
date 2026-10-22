// Named identities keep saved chats and unsent local drafts in one compact navigation rail.
import { Fragment } from "preact";
import { useEffect, useRef, useState } from "preact/hooks";
import { store, navigate } from "./store.js";
import { html, Icon } from "./ui.js";
import { namedAgentsAvailable } from "./named-agents.js";
import { toSessions } from "./sessions.js";
import {
    agentDrafts,
    closeAgentDraft,
    openAgentDraft,
    selectAgentDraft,
    selectedAgentDraft,
} from "./agent-drafts.js";

const dismissed = new Map();
const focusAfterClose = new Map();
const closedKey = (userId, agentId) => `pocket.pipClosedTabs.${userId}.${agentId}`;
const titleOf = (chat) => chat.title || (chat.draft ? "New chat" : `Chat ${chat.id}`);
let pending = null;

/** UI-only tab intent, never authority for settings, Memory, controllers or a loaded conversation. */
function pendingTabAgent() {
    const { me, conversationId, privateId, agentDraft, view, namedAgents, missing } = store.state;
    const agent =
        pending &&
        namedAgentsAvailable() &&
        me.id === pending.userId &&
        conversationId === pending.source &&
        privateId == null &&
        !agentDraft &&
        view.conversation == null &&
        missing == null
            ? namedAgents?.find((item) => item.agentId === pending.agentId)
            : null;

    if (!agent) {
        pending = null;
    }

    return agent ?? null;
}

// Invalidate on access/catalogue/route changes, even if no chrome renders during that change.
store.subscribe(() => pending && pendingTabAgent());

function navigateAgentTab(agentId, source) {
    if (
        !namedAgentsAvailable() ||
        !Number.isSafeInteger(source) ||
        source <= 0 ||
        !store.state.namedAgents?.some((item) => item.agentId === agentId)
    ) {
        return;
    }

    const userId = store.state.me.id;

    navigate(source);
    // Native navigation may publish intermediate state before committing its destination.
    pending = { userId, agentId, source };
    pendingTabAgent();
}

function closedTabs(key) {
    if (!dismissed.has(key)) {
        let ids = [];

        try {
            const saved = JSON.parse(sessionStorage.getItem(key) ?? "[]");

            if (Array.isArray(saved)) {
                ids = saved.filter((id) => Number.isSafeInteger(id) && id > 0);
            }
        } catch {
            // Dismissal remains UI-only when browser storage is unavailable.
        }

        dismissed.set(key, new Set(ids));
    }

    return dismissed.get(key);
}

function ChatTabs({ agent, userId, source, picker, onChoose, expanded, close }) {
    const tabsKey = closedKey(userId, agent.agentId);
    const [, setClosed] = useState(null);
    const closed = closedTabs(tabsKey);
    const links = useRef(new Map());
    const tabs = useRef(new Map());
    const switcher = useRef(null);
    const chats = [...(agent.chats ?? (agent.chatIds ?? []).map((id) => ({ id })))];

    // An exact saved route may arrive before its catalogue event; never infer identity from that event alone.
    if (typeof source === "number" && !chats.some((chat) => chat.id === source)) {
        chats.push({ id: source, title: store.state.view.conversation?.title });
    }

    const visible = [
        ...chats.filter((chat) => !closed.has(chat.id) || chat.id === source),
        ...agentDrafts(agent.agentId),
    ];
    const visibleIds = visible.map((chat) => chat.id).join(",");
    const selected = visible.find((chat) => chat.id === source);
    const current = () =>
        store.state.me?.id === userId &&
        tabChromeAgent()?.agentId === agent.agentId &&
        (selectedAgentDraft()?.id ?? store.state.conversationId) === source;

    const choose = (chat) => {
        if (!current()) {
            return;
        }

        close?.(false);

        if (chat.draft) {
            selectAgentDraft(chat.id);
        } else {
            navigateAgentTab(agent.agentId, chat.id);
        }
    };

    const dismissTabs = (ids) => {
        dismissed.set(tabsKey, ids);
        setClosed(ids);
        // The header rail and its phone picker share the same UI-only dismissal set.
        store.set({});

        try {
            sessionStorage.setItem(tabsKey, JSON.stringify([...ids]));
        } catch {
            // Never alter retained chat data to dismiss a tab.
        }
    };

    useEffect(() => {
        // An outgoing passive effect must not undo a close before the queued root navigation renders.
        // Native navigation and History reopen only the saved chat still selected by the live route.
        if (current() && typeof source === "number" && closedTabs(tabsKey).has(source)) {
            const ids = new Set(closedTabs(tabsKey));

            ids.delete(source);
            dismissTabs(ids);
        }
    }, [source, tabsKey]);
    useEffect(() => {
        if (picker) {
            return;
        }

        tabs.current.get(source)?.scrollIntoView({ block: "nearest", inline: "nearest" });
        const focus = focusAfterClose.get(tabsKey);

        if (focus !== undefined) {
            focusAfterClose.delete(tabsKey);

            if (focus === source && current()) {
                const link = links.current.get(source);
                const visible = link && (!link.getClientRects || link.getClientRects().length);

                (visible ? link : switcher.current)?.focus({ preventScroll: true });
            }
        }
    }, [source, visibleIds]);

    const closeTab = (chat, event) => {
        event.preventDefault();
        event.stopPropagation();

        if (!current()) {
            return;
        }

        const at = visible.findIndex((item) => item.id === chat.id);
        const next = visible[at + 1] ?? visible[at - 1];

        if (chat.draft) {
            closeAgentDraft(chat.id);
        } else {
            const ids = new Set(closedTabs(tabsKey));

            ids.add(chat.id);
            dismissTabs(ids);
        }

        if (picker && chat.id !== source) {
            links.current.get(source)?.focus({ preventScroll: true });
        } else {
            focusAfterClose.set(tabsKey, chat.id === source ? next?.id : source);
        }

        if (chat.id === source) {
            close?.(false);

            if (next?.draft) {
                selectAgentDraft(next.id);
            } else if (next) {
                navigateAgentTab(agent.agentId, next.id);
            } else {
                focusAfterClose.delete(tabsKey);
                Promise.resolve(toSessions()).then(() => {
                    if (
                        store.state.me?.id !== userId ||
                        store.state.conversationId !== null ||
                        selectedAgentDraft() ||
                        store.state.sheet ||
                        store.state.drawer ||
                        store.state.launcher ||
                        typeof document === "undefined"
                    ) {
                        return;
                    }

                    const buttons = document.querySelectorAll(
                        ".named-agent-open, .named-agents-toggle",
                    );
                    const shown = [...buttons].filter((button) => button.getClientRects().length);
                    const target = shown.find((button) => button.dataset.agentId === agent.agentId);

                    (
                        target ??
                        shown[0] ??
                        document.querySelector('.rail button[aria-label="Sessions"]')
                    )?.focus();
                });
            }
        }
    };

    const keyDown = (chat, event) => {
        if (event.metaKey || event.ctrlKey || event.altKey || !current()) {
            return;
        }

        if (event.key === "Delete") {
            closeTab(chat, event);

            return;
        }

        const at = visible.findIndex((item) => item.id === chat.id);
        const next =
            event.key === "Home"
                ? visible[0]
                : event.key === "End"
                  ? visible.at(-1)
                  : event.key === "ArrowRight"
                    ? visible[(at + 1) % visible.length]
                    : event.key === "ArrowLeft"
                      ? visible[(at - 1 + visible.length) % visible.length]
                      : null;

        if (next) {
            event.preventDefault();
            links.current.get(next.id)?.focus();
        }
    };

    const chatItem = (chat, compact = false) => html`<span
        class=${`${compact ? "agent-chat-choice" : "agent-tab-item"} ${chat.id === source ? "on" : ""}`}
        key=${chat.id}
        ref=${
            compact
                ? undefined
                : (element) => {
                      if (element) {
                          tabs.current.set(chat.id, element);
                      } else {
                          tabs.current.delete(chat.id);
                      }
                  }
        }
    >
        <a
            class=${`agent-tab ${chat.id === source ? "on" : ""}`}
            ref=${(element) => {
                if (element) {
                    links.current.set(chat.id, element);
                } else {
                    links.current.delete(chat.id);
                }
            }}
            href=${chat.draft ? undefined : `/s/${chat.id}`}
            role=${chat.draft ? "button" : undefined}
            tabindex=${chat.draft ? "0" : undefined}
            aria-current=${chat.id === source ? "page" : undefined}
            title=${titleOf(chat)}
            onKeyDown=${(event) => {
                if (chat.draft && (event.key === "Enter" || event.key === " ")) {
                    event.preventDefault();
                    choose(chat);
                } else if (!compact) {
                    keyDown(chat, event);
                }
            }}
            onClick=${(event) => {
                if (!current()) {
                    event.preventDefault();

                    return;
                }

                if (
                    !chat.draft &&
                    (event.metaKey || event.ctrlKey || event.shiftKey || event.altKey)
                ) {
                    return;
                }

                event.preventDefault();
                choose(chat);
            }}
        >
            <span class="agent-tab-title">${titleOf(chat)}</span>
            ${chat.draft && html`<span class="small muted">Draft</span>`}
            ${chat.busy && html`<span class="agent-tab-busy" aria-label="Working"></span>`}
        </a>
        <button
            class="agent-tab-close"
            type="button"
            aria-label=${`Close ${titleOf(chat)} ${chat.draft ? "draft" : "tab"}, chat ${chat.id}`}
            title=${
                chat.draft
                    ? chat.requestId
                        ? "Close draft; pending send receipt is kept"
                        : "Discard unsent draft"
                    : "Close tab; chat and running work are kept"
            }
            onClick=${(event) => closeTab(chat, event)}
        ><${Icon} name="close" size=${14} /></button>
    </span>`;

    if (picker) {
        return html`<${Fragment}>
            <p class="small muted">
                Closing a saved tab keeps its chat and running work. Find it again in History.
            </p>
            <nav class="agent-chat-choices" aria-label=${`${agent.name} open chats`}>
                ${visible.map((chat) => chatItem(chat, true))}
            </nav>
        </${Fragment}>`;
    }

    return html`<div class="agent-tabs" data-part="topbar-title">
        <style>@import url("/named-agents.css") layer(pocket);</style>
        <nav class="agent-tabs-strip" aria-label=${`${agent.name} chats`}>
            ${visible.map((chat) => chatItem(chat))}
        </nav>
        <button
            class="agent-chat-switch"
            type="button"
            ref=${switcher}
            aria-label=${`${titleOf(selected ?? {})}: switch chats`}
            aria-haspopup="dialog"
            aria-expanded=${expanded}
            onClick=${(event) => current() && onChoose?.(event)}
        >
            <span class="agent-tab-title">${titleOf(selected ?? {})}</span>
            <${Icon} name="down" size=${14} />
        </button>
        <button
            class="agent-tab-new"
            type="button"
            aria-label=${`New chat with ${agent.name}`}
            title="New chat"
            onClick=${() => current() && openAgentDraft(agent.agentId)}
        ><${Icon} name="plus" size=${16} /></button>
    </div>`;
}

/** Draft identity or the exact selected saved view; never a stale view or catalogue guess. */
export function tabAgent() {
    const { conversationId, view, namedAgents, me } = store.state;

    if (!namedAgentsAvailable() || store.state.server?.privateAgents < 4) {
        return null;
    }

    const draft = selectedAgentDraft();
    const identity =
        draft && draft.userId === me.id && conversationId === null
            ? draft.agentId
            : Number.isSafeInteger(conversationId) && view.conversation?.id === conversationId
              ? view.conversation.pipAgentId
              : null;

    return (namedAgents ?? []).find((item) => item.agentId === identity) ?? null;
}

/** Local tab chrome may use explicit navigation intent; remote actions still require tabAgent(). */
export const tabChromeAgent = () => tabAgent() ?? pendingTabAgent();

export function AgentTabs({ picker = false, onChoose, expanded = false, close } = {}) {
    const agent = tabChromeAgent();
    const { conversationId, me } = store.state;

    if (!agent) {
        return null;
    }

    const source = selectedAgentDraft()?.id ?? conversationId;

    return html`<${ChatTabs}
        key=${`${me.id}:${agent.agentId}`}
        agent=${agent}
        userId=${me.id}
        source=${source}
        picker=${picker}
        onChoose=${onChoose}
        expanded=${expanded}
        close=${close}
    />`;
}
