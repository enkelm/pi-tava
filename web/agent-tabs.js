// Browser-style chat navigation belongs to the current named identity's conversation header.
import { useEffect, useRef, useState } from "preact/hooks";
import { api, store, navigate, uid } from "./store.js";
import { html, Icon } from "./ui.js";
import { namedAgentsAvailable } from "./named-agents.js";
import { toSessions } from "./sessions.js";

const attempts = new Map();
const dismissed = new Map();
const focusAfterClose = new Map();
const receiptKey = (userId, agentId) => `pocket.pipNewChat.${userId}.${agentId}`;
const closedKey = (userId, agentId) => `pocket.pipClosedTabs.${userId}.${agentId}`;
const uncertain = "New chat may have succeeded. Use the + to retry the same request.";

function closedTabs(key) {
    if (!dismissed.has(key)) {
        let ids = [];

        try {
            const saved = JSON.parse(sessionStorage.getItem(key) ?? "[]");

            if (Array.isArray(saved)) {
                ids = saved.filter((id) => Number.isSafeInteger(id) && id > 0);
            }
        } catch {
            // Dismissal is UI-only and still works when browser storage is unavailable.
        }

        dismissed.set(key, new Set(ids));
    }

    return dismissed.get(key);
}

function receipt(key, source) {
    if (!attempts.has(key)) {
        try {
            const saved = sessionStorage.getItem(key);

            if (saved) {
                // Preserve an uncertain request from the previous settings-based UI as well.
                const value = saved.startsWith("{")
                    ? JSON.parse(saved)
                    : { requestId: saved, source };

                if (typeof value.requestId === "string" && Number.isSafeInteger(value.source)) {
                    attempts.set(key, { ...value, error: uncertain });
                }
            }
        } catch {
            // Browser storage can be unavailable; this tab still retains its in-memory request.
        }
    }

    return attempts.get(key);
}

function persist(key, value) {
    if (value) {
        attempts.set(key, value);
    } else {
        attempts.delete(key);
    }

    try {
        if (value) {
            sessionStorage.setItem(
                key,
                JSON.stringify({ requestId: value.requestId, source: value.source }),
            );
        } else {
            sessionStorage.removeItem(key);
        }
    } catch {
        // In-memory identity still protects explicit retries in this tab.
    }
}

function ChatTabs({ agent, userId, source }) {
    const key = receiptKey(userId, agent.agentId);
    const tabsKey = closedKey(userId, agent.agentId);
    const saved = receipt(key, source);
    const [busy, setBusy] = useState(!!saved?.flight);
    const [error, setError] = useState(saved?.error ?? "");
    const [closed, setClosed] = useState(() => closedTabs(tabsKey));
    const epoch = useRef(0);
    const leaving = useRef(false);
    const links = useRef(new Map());
    const tabs = useRef(new Map());
    const chats = [...(agent.chats ?? (agent.chatIds ?? []).map((id) => ({ id })))];

    // A just-opened exact route can precede its catalogue event. It is an existing chat, not a new one.
    if (!chats.some((chat) => chat.id === source)) {
        chats.push({ id: source, title: store.state.view.conversation?.title });
    }

    const visible = chats.filter((chat) => !closed.has(chat.id) || chat.id === source);
    const visibleIds = visible.map((chat) => chat.id).join(",");

    const current = () => {
        const state = store.state;

        return (
            !leaving.current &&
            namedAgentsAvailable() &&
            state.me.id === userId &&
            state.conversationId === source &&
            state.view.conversation?.id === source &&
            state.view.conversation?.pipAgentId === agent.agentId
        );
    };

    const dismissTabs = (ids) => {
        dismissed.set(tabsKey, ids);
        setClosed(ids);

        try {
            sessionStorage.setItem(tabsKey, JSON.stringify([...ids]));
        } catch {
            // Never touch retained chat data or new-chat receipts to dismiss a tab.
        }
    };

    useEffect(() => {
        const opening = ++epoch.current;
        const attempt = receipt(key, source);

        leaving.current = false;
        const live = () => epoch.current === opening && current();

        // Native navigation (history, settings, or an exact link) reopens just that retained chat.
        if (closedTabs(tabsKey).has(source)) {
            const ids = new Set(closedTabs(tabsKey));

            ids.delete(source);
            dismissTabs(ids);
        }

        setBusy(!!attempt?.flight);
        setError(attempt?.error ?? "");

        // Observe an existing request after remount, never replay it or redirect a new opening.
        attempt?.flight?.then(
            () => {
                if (live()) {
                    setBusy(false);
                }
            },
            () => {
                if (live()) {
                    setBusy(false);
                    setError(attempt.error || uncertain);
                }
            },
        );

        return () => {
            epoch.current++;
        };
    }, [source, key]);

    useEffect(() => {
        const selected = links.current.get(source);
        const focus = focusAfterClose.get(tabsKey);

        // The close control is a sibling of the link. Reveal the whole tab in either scrolling layout.
        tabs.current.get(source)?.scrollIntoView({ block: "nearest", inline: "nearest" });

        if (focus !== undefined) {
            focusAfterClose.delete(tabsKey);

            if (focus === source && current()) {
                selected?.focus({ preventScroll: true });
            }
        }
    }, [source, visibleIds]);

    const closeTab = (id, event) => {
        event.preventDefault();
        event.stopPropagation();

        if (!current()) {
            return;
        }

        const ids = new Set(closedTabs(tabsKey));
        const at = visible.findIndex((chat) => chat.id === id);
        const next = visible[at + 1] ?? visible[at - 1];

        ids.add(id);
        dismissTabs(ids);
        focusAfterClose.set(tabsKey, id === source ? next?.id : source);

        if (id === source) {
            // Closing while + is pending must fence its late acknowledgement before navigation settles.
            leaving.current = true;
            epoch.current++;

            if (next) {
                navigate(next.id);
            } else {
                focusAfterClose.delete(tabsKey);
                Promise.resolve(toSessions()).then(() => {
                    if (
                        store.state.me.id !== userId ||
                        store.state.conversationId !== null ||
                        store.state.sheet ||
                        store.state.drawer ||
                        store.state.launcher ||
                        typeof document === "undefined"
                    ) {
                        return;
                    }

                    // Return keyboard focus to existing navigation, including a collapsed PiPs group.
                    const buttons = document.querySelectorAll(
                        ".named-agent-open, .named-agents-toggle",
                    );
                    const shown = [...buttons].filter((button) => button.getClientRects().length);
                    const agentButton = shown.find(
                        (button) => button.dataset.agentId === agent.agentId,
                    );

                    const target =
                        agentButton ??
                        shown[0] ??
                        document.querySelector('.rail button[aria-label="Sessions"]');

                    target?.focus();
                });
            }
        }
    };

    const keyDown = (chat, event) => {
        if (event.metaKey || event.ctrlKey || event.altKey || !current()) {
            return;
        }

        if (event.key === "Delete") {
            closeTab(chat.id, event);

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

    const create = async () => {
        if (!current() || attempts.get(key)?.flight) {
            return;
        }

        const opening = epoch.current;
        const live = () => epoch.current === opening && current();
        const attempt = receipt(key, source) ?? { requestId: uid(), source };

        persist(key, attempt);
        setBusy(true);
        setError("");
        const flight = api(`c/${attempt.source}/private-agent`, {
            action: "new_chat",
            requestId: attempt.requestId,
        }).then((result) => {
            if (result.agentId !== agent.agentId || !Number.isSafeInteger(result.id)) {
                throw new Error("The server returned a different chat identity.");
            }

            return result;
        });

        attempt.flight = flight;

        try {
            const result = await flight;

            persist(key, null);

            if (live()) {
                navigate(result.id);
            }
        } catch (failure) {
            attempt.error = `${failure.message} ${uncertain}`;

            if (live()) {
                setError(attempt.error);
            }
        } finally {
            delete attempt.flight;

            if (live()) {
                setBusy(false);
            }
        }
    };

    return html`<div class="agent-tabs" data-part="topbar-title">
        <style>@import url("/named-agents.css") layer(pocket);</style>
        <nav class="agent-tabs-strip" aria-label=${`${agent.name} chats`} aria-busy=${busy}>
            ${visible.map(
                (chat) => html`<span
                    class=${`agent-tab-item ${chat.id === source ? "on" : ""}`}
                    key=${chat.id}
                    ref=${(element) => {
                        if (element) {
                            tabs.current.set(chat.id, element);
                        } else {
                            tabs.current.delete(chat.id);
                        }
                    }}
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
                        href=${`/s/${chat.id}`}
                        aria-current=${chat.id === source ? "page" : undefined}
                        title=${chat.title || `Chat ${chat.id}`}
                        onKeyDown=${(event) => keyDown(chat, event)}
                        onClick=${(event) => {
                            if (!current()) {
                                event.preventDefault();

                                return;
                            }

                            if (event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) {
                                return;
                            }

                            event.preventDefault();
                            navigate(chat.id);
                        }}
                    >
                        <span class="agent-tab-title">${chat.title || `Chat ${chat.id}`}</span>
                        ${chat.busy && html`<span class="agent-tab-busy" aria-label="Working"></span>`}
                    </a>
                    <button
                        class="agent-tab-close"
                        type="button"
                        aria-label=${`Close ${chat.title || `Chat ${chat.id}`} tab, chat ${chat.id}`}
                        title="Close tab; chat and running work are kept"
                        onClick=${(event) => closeTab(chat.id, event)}
                    ><${Icon} name="close" size=${14} /></button>
                </span>`,
            )}
            <button
                class="agent-tab-new"
                type="button"
                aria-label=${`${saved?.error ? "Retry new chat" : "New chat"} with ${agent.name}`}
                title=${busy ? "Creating chat…" : saved?.error ? "Retry new chat" : "New chat"}
                disabled=${busy}
                onClick=${create}
            ><${Icon} name="plus" size=${16} /></button>
        </nav>
        ${error && html`<p class="agent-tabs-error small" role="alert">${error}</p>`}
    </div>`;
}

/** Shared with the normal header so older servers and non-agent conversations keep their existing chrome. */
export function tabAgent() {
    const { conversationId, view, namedAgents } = store.state;
    const identity = view.conversation?.pipAgentId;

    if (!namedAgentsAvailable() || view.conversation?.id !== conversationId) {
        return null;
    }

    return (namedAgents ?? []).find((item) => item.agentId === identity) ?? null;
}

export function AgentTabs() {
    const agent = tabAgent();
    const { conversationId, me } = store.state;

    if (!agent) {
        return null;
    }

    return html`<${ChatTabs} key=${`${me.id}:${agent.agentId}`} agent=${agent} userId=${me.id} source=${conversationId} />`;
}
