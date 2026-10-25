// Named identities keep saved chats and unsent local drafts in one compact navigation rail.
import { Fragment } from "preact";
import { useEffect, useRef, useState } from "preact/hooks";
import { api, drafts, navigate, notify, store } from "./store.js";
import { html, Icon } from "./ui.js";
import { namedAgentsAvailable } from "./named-agents.js";
import { toSessions } from "./sessions.js";
import { NamedAgentAvatar } from "./named-agent-avatar.js";
import {
    agentDrafts,
    closeAgentDraft,
    openAgentDraft,
    selectAgentDraft,
    selectedAgentDraft,
} from "./agent-drafts.js";

const focusAfterClose = new Map();
// Pending HTTP requests only, shared by the rail and picker; never a closed-Chat registry.
const closeRequests = new Set();
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

function ChatTabs({ agent, userId, source, picker, onChoose, expanded, close }) {
    const tabsKey = `${userId}:${agent.agentId}`;
    const [closing, setClosing] = useState(new Set());
    const inFlight = useRef(new Set());
    const links = useRef(new Map());
    const tabs = useRef(new Map());
    const switcher = useRef(null);
    const chats = [...(agent.chats ?? (agent.chatIds ?? []).map((id) => ({ id })))].filter(
        (chat) => !chat.archived,
    );

    // An exact saved route may arrive before its catalogue event; never infer identity from that event alone.
    if (
        typeof source === "number" &&
        !store.state.view.conversation?.archived &&
        !chats.some((chat) => chat.id === source)
    ) {
        chats.push({ id: source, title: store.state.view.conversation?.title });
    }

    const visible = [...chats, ...agentDrafts(agent.agentId)];
    const visibleIds = visible.map((chat) => chat.id).join(",");
    const selected = visible.find((chat) => chat.id === source);
    const selectedTitle = selected ? titleOf(selected) : "Closed chat";
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

    const closeTab = async (chat, event) => {
        event.preventDefault();
        event.stopPropagation();

        const requestKey = `${tabsKey}:${chat.id}`;

        if (!current() || closeRequests.has(requestKey)) {
            return;
        }

        const at = visible.findIndex((item) => item.id === chat.id);

        if (chat.draft) {
            closeAgentDraft(chat.id);
        } else {
            if (!(store.state.server.agentChatArchiveChildren >= 1)) {
                notify(
                    "error",
                    "This server cannot safely close a Chat with its children yet. Update/restart the server, then reload. The Chat was kept open.",
                );

                return;
            }

            const beforeChat = store.state.namedAgents
                .find((item) => item.agentId === agent.agentId)
                ?.chats?.find((item) => item.id === chat.id);
            // Read the target Chat's latest activity, not a sibling or a stale render's flags.
            const activity = beforeChat ?? chat;

            if (
                ((activity.busy || activity.managing || activity.runningChildren) &&
                    !confirm(
                        `Close “${titleOf(chat)}” everywhere? This stops and archives this Chat and its current owned child Work Items. Already completed external effects cannot be undone. Unsent drafts are discarded. History remains recoverable; restore child Work Items separately. Restore never resumes old work.`,
                    )) ||
                !current()
            ) {
                return;
            }

            const beforeView = store.state.view.conversation;
            const draftRevision = drafts.revision(chat.id);

            closeRequests.add(requestKey);
            inFlight.current.add(chat.id);
            setClosing(new Set(inFlight.current));

            try {
                const result = await api(
                    `pip/agents/${encodeURIComponent(agent.agentId)}/close-chat-v1`,
                    { chatId: chat.id },
                );

                if (
                    result?.ok !== true ||
                    result.chatId !== chat.id ||
                    result.scope !== "owned-v1"
                ) {
                    throw new Error(
                        "The server did not acknowledge the owned Close scope. Reload to inspect the native state; do not retry blindly.",
                    );
                }
            } catch (error) {
                if (current()) {
                    notify("error", error.message || "Could not close this Chat.");
                }

                return;
            } finally {
                closeRequests.delete(requestKey);
                inFlight.current.delete(chat.id);
                setClosing(new Set(inFlight.current));
            }

            if (store.state.me?.id !== userId) {
                return;
            }

            const latestChat = store.state.namedAgents
                .find((item) => item.agentId === agent.agentId)
                ?.chats?.find((item) => item.id === chat.id);
            const latestView = store.state.view.conversation;

            // Native events may already include a subsequent Restore. A delayed HTTP response
            // cannot replace newer authoritative snapshots or clear their fresh composer.
            if (
                (latestChat && latestChat !== beforeChat && !latestChat.archived) ||
                (latestView?.id === chat.id && latestView !== beforeView && !latestView.archived)
            ) {
                return;
            }

            const stillHere = current();

            // Cleanup belongs to the successfully closed Chat, not the selected route. Do it
            // before marking its row archived, so a later catalogue event cannot lose that edge.
            if (drafts.revision(chat.id) === draftRevision) {
                drafts.discard(chat.id);
            }

            // Reflect the accepted native archive until its catalogue/view event arrives. No local
            // dismissal registry: a fresh browser reads the same archived state from the server.
            store.set((state) => ({
                namedAgents: state.namedAgents.map((item) =>
                    item.agentId !== agent.agentId
                        ? item
                        : {
                              ...item,
                              id:
                                  item.id === chat.id
                                      ? ((item.chats ?? [])
                                            .filter(
                                                (entry) => entry.id !== chat.id && !entry.archived,
                                            )
                                            .at(-1)?.id ?? null)
                                      : item.id,
                              chats: item.chats?.map((entry) =>
                                  entry.id === chat.id
                                      ? {
                                            ...entry,
                                            archived: true,
                                            busy: false,
                                            managing: false,
                                            runningChildren: false,
                                        }
                                      : entry,
                              ),
                              chatIds: item.chatIds?.filter((id) => id !== chat.id),
                          },
                ),
                ...(state.view.conversation?.id === chat.id
                    ? {
                          view: {
                              ...state.view,
                              conversation: { ...state.view.conversation, archived: true },
                          },
                      }
                    : {}),
            }));

            if (!stillHere) {
                return;
            }
        }

        const liveAgent = store.state.namedAgents.find((item) => item.agentId === agent.agentId);
        const eligible = [
            ...(liveAgent?.chats ?? (liveAgent?.chatIds ?? []).map((id) => ({ id }))),
            ...agentDrafts(agent.agentId),
        ].filter(
            (item) =>
                item.id !== chat.id &&
                !item.archived &&
                !closeRequests.has(`${tabsKey}:${item.id}`),
        );
        const byId = new Map(eligible.map((item) => [item.id, item]));
        // Resolve neighbors after acknowledgement: a sibling Close may have removed the old
        // neighbor, or it may still be pending and therefore ineligible as a destination.
        const next =
            [...visible.slice(at + 1), ...visible.slice(0, at).reverse()]
                .map((item) => byId.get(item.id))
                .find(Boolean) ?? eligible[0];

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
            <${NamedAgentAvatar}
                agentId=${agent.agentId}
                size=${22}
                animated=${true}
                thinking=${chat.busy || chat.managing}
            />
            <span class="agent-tab-title">${titleOf(chat)}</span>
            ${chat.draft && html`<span class="small muted">Draft</span>`}
            ${
                (chat.busy || chat.managing) &&
                html`<span class="sr-only">
                    ${chat.busy ? "Working" : "Managing orchestration"}
                </span>`
            }
        </a>
        <button
            class="agent-tab-close"
            type="button"
            aria-label=${`Close ${titleOf(chat)} ${chat.draft ? "draft" : "tab"}, chat ${chat.id}`}
            disabled=${closing.has(chat.id) || closeRequests.has(`${tabsKey}:${chat.id}`)}
            title=${
                chat.draft
                    ? chat.requestId
                        ? "Close draft; pending send receipt is kept"
                        : "Discard unsent draft"
                    : "Close Chat and owned Work Items everywhere; saved history stays recoverable"
            }
            onClick=${(event) => closeTab(chat, event)}
        ><${Icon} name="close" size=${14} /></button>
    </span>`;

    if (picker) {
        return html`<${Fragment}>
            <p class="small muted">
                Closing a saved Chat stops and archives it and its owned child Work Items everywhere. History stays recoverable. Restore Work Items separately; restoring never resumes old work.
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
            aria-label=${`${selectedTitle}: switch chats`}
            aria-description=${
                selected?.busy
                    ? "Working"
                    : selected?.managing
                      ? "Managing orchestration"
                      : undefined
            }
            aria-haspopup="dialog"
            aria-expanded=${expanded}
            onClick=${(event) => current() && onChoose?.(event)}
        >
            <${NamedAgentAvatar}
                agentId=${agent.agentId}
                size=${22}
                animated=${true}
                thinking=${selected?.busy || selected?.managing}
            />
            <span class="agent-tab-title">${selectedTitle}</span>
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
