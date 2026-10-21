const WORKFLOW_LABELS = {
    active: "Active",
    "review-complete": "Review complete",
    landed: "Locally landed",
    published: "Published",
    "needs-review": "Needs review",
};

export function createControls(pocket, state) {
    const { html, Icon } = pocket;

    function HandoffButton() {
        const { session, status } = state.useContext();
        const { id, sessions } = session;
        const source = sessions.find((each) => each.id === id);
        const data = status.data;

        if (
            !session.canSteer ||
            !session.me ||
            id === null ||
            session.conversation?.kind !== "session" ||
            source?.workflow?.readOnly ||
            data?.workflow?.readOnly ||
            source?.workflow?.profileAvailable === false ||
            data?.workflow?.profileAvailable === false
        ) {
            return null;
        }

        const open = () => {
            if (state.isCurrent(session.me.id, id) && pocket.session().canSteer) {
                pocket.openSheet("handoff", { id, opening: pocket.requestId() });
            }
        };

        return html`<button
            class="handoff-icon-button handoff-button"
            aria-label="Choose next thread"
            title="Choose the next thread and add instructions"
            onClick=${open}
        >
            <${Icon} name="fork" />
        </button>`;
    }

    /** Retired threads remain promptable; this status explains their workspace ownership. */
    function WorkflowTools() {
        const { session, status } = state.useContext();
        const { id, sessions } = session;

        if (!session.me || id === null || session.conversation?.kind !== "session") {
            return null;
        }

        const sourceSession = sessions.find((each) => each.id === id);
        const data = status.data;
        const workflow = {
            ...sourceSession?.workflow,
            ...data?.workflow,
            readOnly: Boolean(sourceSession?.workflow?.readOnly || data?.workflow?.readOnly),
            preparing: Boolean(sourceSession?.workflow?.preparing || data?.workflow?.preparing),
            paused: Boolean(sourceSession?.workflow?.paused || data?.workflow?.paused),
        };
        const incoming = data?.handoffs?.find((handoff) => handoff.targetThreadId === id);
        const source = sessions.find((each) => each.id === incoming?.sourceThreadId);
        const type = session.conversation.threadType ?? sourceSession?.threadType;

        if (
            !sourceSession?.workflow?.managed &&
            !data?.workflow?.managed &&
            !workflow.preparing &&
            !source
        ) {
            return null;
        }

        const label = workflow.preparing
            ? "Preparing handoff summary"
            : workflow.profileAvailable === false
              ? "Agent profile unavailable"
              : workflow.readOnly
                ? "Read-only workspace"
                : workflow.paused
                  ? "Work Item execution paused"
                  : "Workflow status";
        const description = workflow.preparing
            ? "Preparing handoff summary… · wait for the new thread to open"
            : workflow.profileAvailable === false
              ? "Agent profile unavailable · enable its workflow extension before continuing work"
              : workflow.readOnly
                ? "Read-only workspace · ask questions here; only the active thread can make changes"
                : workflow.paused
                  ? "Work Item execution paused · ask the owner to resume it; reading and discussion remain available"
                  : `${WORKFLOW_LABELS[workflow.status] ?? "Active"}${workflow.readyForPublish ? " · ready to publish, not approval to deliver" : type === "publish" ? " · each external action needs human approval" : type === "land" ? " · local integration only" : ""}`;
        const tooltip = [description, workflow.summary].filter(Boolean).join("\n");
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
                ><${Icon} name=${icon} size=${16}
            /></span>
        </div>`;
    }

    return { HandoffButton, WorkflowTools };
}
