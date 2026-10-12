// Agents author briefs and readiness; only an explicit human action starts the next independent thread.
import { useEffect, useRef, useState } from "preact/hooks";
import {
    actions,
    canSteer,
    handoffsAvailable,
    navigate,
    notify,
    openSheet,
    store,
    uid,
} from "./store.js";
import { ThreadTypeTag } from "./thread-type.js";
import { html, Icon, Spinner } from "./ui.js";

export const HANDOFF_LABELS = {
    chat: "Start chat",
    reviewer: "Start review",
    land: "Start land",
    publish: "Start publish",
    worker: "Start worker",
};

export const WORKFLOW_LABELS = {
    active: "Active",
    "review-complete": "Review complete",
    landed: "Locally landed",
    published: "Published",
    "needs-review": "Needs review",
};

/** Keep the common workflow focused. Explicit native commands retain advanced transitions. */
export function handoffOptions(data, type) {
    const next = {
        chat: ["worker", "reviewer"],
        worker: ["reviewer"],
        reviewer: ["land", "worker"],
        land: ["publish", "reviewer", "worker"],
        publish: ["worker", "reviewer"],
    }[type ?? "worker"] ?? ["reviewer"];

    return (data?.options ?? []).filter(
        (option) => option.enabled && next.includes(option.targetType),
    );
}

export function preferredHandoff(data, type) {
    const options = handoffOptions(data, type);
    const expected = type === "reviewer" ? "land" : type === "land" ? "publish" : "reviewer";
    const recommendations = [
        data?.workflow?.proposal,
        ...(data?.workflow?.recommendations ?? []),
    ].filter(Boolean);

    for (const recommendation of recommendations) {
        const option = options.find(
            (each) =>
                each.targetType === recommendation.targetType &&
                each.relationship === recommendation.relationship,
        );

        if (option) {
            return option;
        }
    }

    return (
        options.find((option) => option.targetType === expected) ??
        (options.length === 1 ? options[0] : null)
    );
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
    const available = handoffsAvailable() && view.conversation?.kind === "session";
    const session = sessions.find((each) => each.id === id);
    const status = session?.workflow?.status;
    const readOnly = session?.workflow?.readOnly;
    const busy = view.live?.busy;
    const request = useRef(null);
    const submitting = useRef(false);
    const [starting, setStarting] = useState(false);
    const [failed, setFailed] = useState(null);

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
    const type = view.conversation.threadType ?? session?.threadType ?? "worker";
    const options = handoffOptions(data, type);
    // A lost response may have retired the source already. Retry only the admitted, immutable request.
    const pending = request.current?.id === id ? request.current : null;
    const retry = failed === pending && pending !== null;
    const frozen = data?.workflow?.readOnly || readOnly;

    if (frozen && !pending) {
        return null;
    }

    const preferred = pending?.option ?? preferredHandoff(data, type);
    const label = preferred ? HANDOFF_LABELS[preferred.targetType] : "Handoff";

    const activate = async (option) => {
        if (submitting.current) {
            return;
        }

        const admitted = pending ?? { id, option, requestId: uid() };

        request.current = admitted;
        submitting.current = true;
        setStarting(true);
        setFailed(null);

        try {
            const created = await actions.createHandoff(id, {
                targetType: admitted.option.targetType,
                relationship: admitted.option.relationship,
                requestId: admitted.requestId,
            });

            request.current = null;

            if (store.state.conversationId === id) {
                navigate(created.id);
            }
        } catch (failure) {
            setFailed(admitted);
            notify("error", `${failure.message} Retry to open the same handoff.`);
        } finally {
            submitting.current = false;
            setStarting(false);
        }
    };

    return html`<button
        class="icon-button handoff-button"
        aria-label=${retry ? `Retry ${label.toLowerCase()}` : label}
        title=${retry ? `Retry ${label.toLowerCase()} · same request, no duplicate thread` : `${label} · previous thread becomes read-only`}
        aria-busy=${starting || undefined}
        disabled=${starting || (!pending && (!data || options.length === 0))}
        onClick=${() => {
            if (pending || options.length === 1) {
                activate(pending?.option ?? options[0]);
            } else {
                openSheet({ type: "handoff", id, option: preferred });
            }
        }}
    >
        ${starting ? html`<${Spinner} />` : preferred ? html`<${ThreadTypeTag} session=${{ threadType: preferred.targetType }} iconOnly=${true} />` : html`<${Icon} name="fork" />`}
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
