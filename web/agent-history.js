// Saved-chat History uses native archive/restore; opening a restored Chat never restarts its work.
import { useEffect, useState } from "preact/hooks";
import { actions, api, navigate } from "./store.js";
import { html, Icon, timeAgo } from "./ui.js";

export function AgentHistory({ agent, source, current, close }) {
    const [read, setRead] = useState({ loading: true });
    const [revision, setRevision] = useState(0);
    const [restoring, setRestoring] = useState(null);

    useEffect(() => {
        if (!current()) {
            return;
        }

        const stop = new AbortController();
        let active = true;
        const live = () => active && !stop.signal.aborted && current();

        setRead((previous) => ({ loading: true, data: previous.data }));
        // This passive read also recovers admitted first sends whose draft lost its acknowledgement.
        api(`pip/agents/${encodeURIComponent(agent.agentId)}`, undefined, {
            signal: stop.signal,
        }).then(
            (data) => {
                if (!live()) {
                    return;
                }

                if (data.agentId !== agent.agentId || !Array.isArray(data.chats)) {
                    setRead((previous) => ({
                        loading: false,
                        data: previous.data,
                        error: "The response did not match this agent. Refresh to retry.",
                    }));

                    return;
                }

                setRead({ loading: false, data });
            },
            (failure) => {
                if (live()) {
                    setRead((previous) => ({
                        loading: false,
                        data: previous.data,
                        error: failure.message || "Could not load saved chats.",
                    }));
                }
            },
        );

        return () => {
            active = false;
            stop.abort();
        };
    }, [agent.agentId, source, revision]);

    const chats = read.data?.chats ?? agent.chats ?? [];

    const open = async (chat, event) => {
        if (!current()) {
            event.preventDefault();

            return;
        }

        if (!chat.archived && (event.metaKey || event.ctrlKey || event.shiftKey || event.altKey)) {
            return;
        }

        event.preventDefault();

        if (chat.archived) {
            if (restoring !== null) {
                return;
            }

            setRestoring(chat.id);

            try {
                await actions.updateSession(chat.id, { archived: false });
            } catch (failure) {
                if (current()) {
                    setRead((previous) => ({
                        ...previous,
                        error: failure.message || "Could not restore this Chat.",
                    }));
                }

                return;
            } finally {
                setRestoring(null);
            }
        }

        if (current()) {
            close(false);
            navigate(chat.id);
        }
    };

    return html`<div class="agent-chat-history" aria-busy=${read.loading}>
        <p class="small muted">All saved chats with ${agent.name}. Restore a closed Chat everywhere without restarting its work.</p>
        ${read.loading && html`<p class="small muted" role="status">Loading saved chats…</p>`}
        ${read.error && html`<p role="alert">${read.error} Showing last known chats.</p>`}
        ${!read.loading && !read.error && chats.length === 0 && html`<p>No saved chats yet. Send a message in a new chat to save it.</p>`}
        <nav class="agent-history-list" aria-label=${`${agent.name} saved chats`}>
            ${chats.map(
                (chat) => html`<${chat.archived ? "button" : "a"}
                class=${`agent-history-chat ${chat.id === source ? "on" : ""}`}
                key=${chat.id}
                href=${chat.archived ? undefined : `/s/${chat.id}`}
                type=${chat.archived ? "button" : undefined}
                disabled=${chat.archived ? restoring !== null : undefined}
                aria-label=${chat.archived ? `Restore ${chat.title || `Chat ${chat.id}`}` : undefined}
                aria-current=${chat.id === source ? "page" : undefined}
                onClick=${(event) => open(chat, event)}
            >
                <span class="agent-history-chat-copy">
                    <span>${chat.title || `Chat ${chat.id}`}</span>
                    ${chat.updatedAt && html`<span class="small muted">${timeAgo(chat.updatedAt)}</span>`}
                </span>
                ${
                    chat.archived
                        ? html`<span class="small muted">${restoring === chat.id ? "Restoring…" : "Restore"}</span>`
                        : (chat.busy || chat.managing) &&
                          html`<span class="small muted">${chat.busy ? "Working" : "Managing orchestration"}</span>`
                }
                <${Icon} name=${chat.archived ? "unarchive" : "chevron"} size=${16} />
            </${chat.archived ? "button" : "a"}>`,
            )}
        </nav>
        <button
            class="button"
            type="button"
            disabled=${read.loading}
            onClick=${() => current() && setRevision((value) => value + 1)}
        >Refresh</button>
    </div>`;
}
