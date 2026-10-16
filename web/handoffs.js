// Humans choose the next role; the source agent summarizes before the backend starts that thread.
import { useEffect } from "preact/hooks";
import {
    actions,
    canSteer,
    handoffsAvailable,
    handoffSummaryAvailable,
    navigate,
    openSheet,
    store,
} from "./store.js";
import { ThreadTypeTag } from "./thread-type.js";
import { html, Icon } from "./ui.js";

export const HANDOFF_LABELS = {
    chat: "Start chat",
    reviewer: "Start review",
    land: "Start land",
    publish: "Start publish",
    worker: "Start worker",
    researcher: "Start researcher",
    "follow-up": "Start follow-up",
    pull: "Start pull",
};

export const WORKFLOW_LABELS = {
    active: "Active",
    "review-complete": "Review complete",
    landed: "Locally landed",
    published: "Published",
    "needs-review": "Needs review",
};

/** The server owns eligibility, including disabled paths and their reasons. */
export function handoffOptions(data) {
    return data?.options ?? [];
}

export async function refreshHandoffs(id) {
    const data = await actions.handoffs(id);

    if (store.state.conversationId === id && handoffsAvailable()) {
        store.set({ handoff: { id, data } });
    }

    return data;
}

export function HandoffButton() {
    const { conversationId: id, view, sessions } = store.state;
    const available = handoffSummaryAvailable() && view.conversation?.kind === "session";
    const session = sessions.find((each) => each.id === id);
    const status = session?.workflow?.status;
    const readOnly = session?.workflow?.readOnly;
    const busy = view.live?.busy;

    useEffect(() => {
        if (!available) {
            return;
        }

        let stopped = false;

        const refresh = () => {
            actions.handoffs(id).then(
                (data) => {
                    if (!stopped && store.state.conversationId === id) {
                        store.set({ handoff: { id, data } });
                    }
                },
                () => {},
            );
        };

        refresh();
        const timer = setInterval(refresh, 10_000);

        return () => {
            stopped = true;
            clearInterval(timer);
        };
    }, [available, id, status, readOnly, busy]);

    if (!available || !canSteer()) {
        return null;
    }

    const data = store.state.handoff?.id === id ? store.state.handoff.data : null;
    const preparing = Boolean(session?.workflow?.preparing ?? data?.workflow?.preparing);

    if (data?.workflow?.readOnly || readOnly) {
        return null;
    }

    return html`<button
        class="icon-button handoff-button"
        aria-label="Choose next thread"
        aria-busy=${preparing}
        disabled=${preparing}
        title=${preparing ? "Preparing handoff summary…" : "Choose the next thread · starting it makes this thread read-only"}
        onClick=${() => openSheet({ type: "handoff", id })}
    >
        <${Icon} name="fork" />
    </button>`;
}

/** Quiet, icon-only context in the chatbox; retired conversations remain promptable but cannot write. */
export function WorkflowTools() {
    const { conversationId: id, sessions, view } = store.state;

    if (!handoffsAvailable() || view.conversation?.kind !== "session") {
        return null;
    }

    const session = sessions.find((each) => each.id === id);
    const data = store.state.handoff?.id === id ? store.state.handoff.data : null;
    const workflow = {
        ...session?.workflow,
        ...data?.workflow,
        readOnly: Boolean(session?.workflow?.readOnly || data?.workflow?.readOnly),
    };
    const item = data?.workItem;
    const active = sessions.find(
        (each) => each.id === (item?.activeThreadId ?? session?.activeThreadId),
    );
    const origin = sessions.find((each) => each.id === item?.originThreadId);
    const incoming = data?.handoffs?.find((handoff) => handoff.targetThreadId === id);
    const source = sessions.find((each) => each.id === incoming?.sourceThreadId);
    const type = view.conversation.threadType ?? session?.threadType;

    if (!session?.workflow?.managed && !data?.workflow?.managed && !source) {
        return null;
    }

    const label = workflow.readOnly ? "Read-only workspace" : "Workflow status";
    const status = workflow.readOnly
        ? "Read-only workspace · ask questions here; only the active thread can make changes"
        : `${WORKFLOW_LABELS[workflow.status] ?? "Active"}${workflow.readyForPublish ? " · ready to publish, not approval to deliver" : type === "publish" ? " · each external action needs human approval" : type === "land" ? " · local integration only" : ""}`;
    const tooltip = [status, workflow.summary].filter(Boolean).join("\n");
    const icon = workflow.readOnly
        ? "shield"
        : workflow.status === "needs-review"
          ? "search"
          : ["review-complete", "landed", "published"].includes(workflow.status)
            ? "check"
            : "pulse";

    return html`<div class="workflow-tools" role="group" aria-label="Work Item context">
        <span
            class=${`workflow-state ${workflow.readOnly ? "read-only" : ""}`}
            role="img"
            tabindex="0"
            aria-label=${label}
            aria-description=${tooltip}
            title=${tooltip}
        ><${Icon} name=${icon} size=${16} /></span>
        ${active && active.id !== id && html`<button class="icon-button" aria-label="Open active thread" title="Open active thread" onClick=${() => navigate(active.id)}><${ThreadTypeTag} session=${active} iconOnly=${true} /></button>`}
        ${source && source.id !== id && html`<button class="icon-button" aria-label=${incoming.relationship === "new-work" ? "Previous Work Item" : "Previous thread"} title=${incoming.relationship === "new-work" ? "Previous Work Item" : "Previous thread"} onClick=${() => navigate(source.id)}><${Icon} name="back" size=${16} /></button>`}
        ${origin && origin.id !== id && origin.id !== source?.id && html`<button class="icon-button" aria-label="Source worker" title="Source worker" onClick=${() => navigate(origin.id)}><${Icon} name="bot" size=${16} /></button>`}
    </div>`;
}
