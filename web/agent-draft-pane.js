// Unsaved Chats reuse the native Composer without opening a Durable room.
import { useEffect, useState } from "preact/hooks";
import { Composer } from "./composer.js";
import { html } from "./ui.js";
import { store } from "./store.js";
import { recoverAgentDraft, selectedAgentDraft } from "./agent-drafts.js";

export function AgentDraftPane() {
    const draft = selectedAgentDraft();
    const [error, setError] = useState("");

    useEffect(() => {
        if (draft?.requestId) {
            recoverAgentDraft(draft.id).catch((failure) => setError(failure.message));
        }
    }, [draft?.id]);

    if (!draft) {
        return html`<div class="empty">This draft was closed or belongs to another sign-in. Open the PiP to start a new chat.</div>`;
    }

    const agent = store.state.namedAgents.find((item) => item.agentId === draft.agentId);
    const check = () =>
        recoverAgentDraft(draft.id)
            .then((result) =>
                setError(result ? "" : "No accepted message yet. Retry uses the same request."),
            )
            .catch((failure) => setError(failure.message));

    return html`<div class="transcript agent-draft-empty">
        <div class="empty">
            <h2>New chat with ${agent?.name ?? "your PiP"}</h2>
            <p>Memory and instructions are shared across this PiP's chats.</p>
            <p class="small muted">Saved to History when your first message is accepted. Closing an unused draft discards it.</p>
            ${error && html`<p class="error-box" role="alert">${error}</p>`}
        </div>
    </div>
    <${Composer} draft=${draft} onCheckDraft=${check} />`;
}
