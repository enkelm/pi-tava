// Humans choose a role explicitly; the source agent supplies the summary, not the flow.
import { useEffect, useRef, useState } from "preact/hooks";
import { HANDOFF_LABELS, handoffOptions } from "../handoffs.js";
import {
    actions,
    canSteer,
    closeSheet,
    handoffSummaryAvailable,
    navigate,
    store,
    uid,
} from "../store.js";
import { ThreadTypeTag } from "../thread-type.js";
import { html, Loader, Sheet } from "../ui.js";

const keyOf = (option) => `${option.targetType}:${option.relationship}`;
const DESCRIPTIONS = {
    worker: "Implement the requested work with focused tests in a fresh Worker.",
    researcher: "Investigate a pointed question and return findings for the next stage.",
    reviewer: "Independent code and test review, fixes and impact-driven regression checks.",
    "follow-up":
        "Finish review repairs and self-review the repair and its immediate integration points.",
    pull: "Read tickets and PRs, agree on direction with a human or collect a handoff, and update worktrees.",
    land: "Integrate and verify locally; no external delivery.",
    publish:
        "Push changes or update PRs and tickets. Each external action requires separate human approval.",
};

export function HandoffSheet({ id, opening }) {
    const available = handoffSummaryAvailable();
    // Closing animation can retain this component across a new opening of the same thread.
    const [loaded, setLoaded] = useState(null);
    const [pending, setLoading] = useState(true);
    const data = loaded?.opening === opening ? loaded?.data : null;
    const loading = pending || loaded?.opening !== opening;
    const [choice, setChoice] = useState("");
    const [busy, setBusy] = useState(false);
    const [uncertain, setUncertain] = useState(false);
    const [error, setError] = useState("");
    const [retry, setRetry] = useState(0);
    const submitting = useRef(false);
    const request = useRef({ id: uid(), payload: null });

    useEffect(() => {
        if (!available) {
            return;
        }

        let stopped = false;

        setLoading(true);
        setError("");
        actions.handoffs(id).then(
            (value) => {
                if (stopped) {
                    return;
                }

                setLoaded({ opening, data: value });
                setLoading(false);
                setChoice((old) =>
                    data &&
                    handoffOptions(value).some((each) => each.enabled && keyOf(each) === old)
                        ? old
                        : "",
                );
            },
            (failure) => {
                if (!stopped) {
                    setError(failure.message);
                    setLoaded({ opening, data: null });
                    setLoading(false);
                }
            },
        );

        return () => {
            stopped = true;
        };
    }, [id, retry, opening, available]);

    if (!canSteer()) {
        return null;
    }

    if (!available) {
        return html`<${Sheet} title="Handoff" onClose=${closeSheet}>
            <p role="status">The updated handoff flow requires a server restart. Ask the owner to restart after validation.</p>
            <button class="button" onClick=${closeSheet}>Close</button>
        <//>`;
    }

    const options = handoffOptions(data);
    const selected = options.find((each) => keyOf(each) === choice);
    const valid = selected?.enabled && !data?.workflow?.readOnly;
    const groups = [
        { relationship: "same-work", label: "Same Work Item" },
        { relationship: "new-work", label: "New Work Item" },
    ];

    const save = async (event) => {
        event.preventDefault();

        if (submitting.current || !valid) {
            return;
        }

        const opened = store.state.sheet;
        // An uncertain response may hide a committed successor. Retry that exact admission,
        // never replace its identity or payload until the server definitively rejects it.
        const payload = request.current.payload ?? {
            targetType: selected.targetType,
            relationship: selected.relationship,
        };

        request.current.payload = payload;
        submitting.current = true;
        setBusy(true);
        setError("");

        try {
            const created = await actions.createHandoff(id, {
                ...payload,
                requestId: request.current.id,
            });

            if (store.state.sheet === opened && store.state.conversationId === id) {
                navigate(created.id);
            }
        } catch (failure) {
            if (!uncertain && failure.status >= 400 && failure.status < 500) {
                request.current = { id: uid(), payload: null };
                setError(`${failure.message} Refresh options or choose another role.`);
            } else {
                setUncertain(true);
                setError(`${failure.message} Retry to recover the same handoff request.`);
            }
        } finally {
            submitting.current = false;
            setBusy(false);
        }
    };

    return html`<${Sheet} title="Handoff" onClose=${busy ? () => {} : closeSheet}>
        ${loading && html`<${Loader} label="Loading handoff options" />`}
        ${
            !loading &&
            !data &&
            html`
            <p class="error" role="alert">${error}</p>
            <button class="button" onClick=${() => setRetry((each) => each + 1)}>Retry</button>
        `
        }
        ${
            !loading &&
            data &&
            html`<form class="handoff-form" onSubmit=${save} aria-busy=${busy}>
            <p class="muted small">Choose the next role. This agent will prepare a summary, then the new thread opens and this one becomes read-only.</p>
            ${groups.map((group) => {
                const choices = options.filter((each) => each.relationship === group.relationship);

                if (choices.length === 0) {
                    return null;
                }

                return html`<fieldset aria-label=${group.label} disabled=${busy || uncertain}>
                    <legend class="label">${group.label}</legend>
                    ${group.relationship === "new-work" && html`<p class="muted small">Start separate work linked to this Work Item.</p>`}
                    <div class="handoff-options">
                        ${choices.map((each) => {
                            const disabled = !each.enabled || data.workflow?.readOnly;

                            return html`<label class=${`handoff-option ${disabled ? "disabled" : ""}`}>
                                <input
                                    type="radio"
                                    name="handoff-option"
                                    value=${keyOf(each)}
                                    checked=${choice === keyOf(each)}
                                    disabled=${disabled}
                                    onChange=${() => setChoice(keyOf(each))}
                                />
                                <${ThreadTypeTag}
                                    session=${{ threadType: each.targetType }}
                                    iconOnly=${true}
                                />
                                <span class="handoff-option-copy">
                                    <strong>${HANDOFF_LABELS[each.targetType] ?? each.targetType}</strong>
                                    ${each.reason && html`<span class="small muted handoff-disabled-reason">${each.reason}</span>`}
                                </span>
                            </label>`;
                        })}
                    </div>
                </fieldset>`;
            })}
            ${options.length === 0 && html`<p class="muted small">${data.workflow?.readOnly ? "Open the active thread to continue this work." : "No handoff options are available from this server."}</p>`}
            ${selected && html`<p class="small handoff-explanation">${DESCRIPTIONS[selected.targetType]}</p>`}
            ${error && html`<p class="error" role="alert">${error}</p>`}
            <div class="handoff-form-actions">
                <button
                    class="button"
                    type="button"
                    disabled=${busy || uncertain}
                    title=${uncertain ? "Retry the existing handoff request before refreshing options" : "Reload roles and their current availability"}
                    onClick=${() => setRetry((each) => each + 1)}
                >Refresh options</button>
                <button class="button" type="button" disabled=${busy} onClick=${closeSheet}>Cancel</button>
                <button class="button primary" type="submit" disabled=${busy || !valid}>
                    ${busy ? "Preparing summary…" : (HANDOFF_LABELS[selected?.targetType] ?? "Start thread")}
                </button>
            </div>
        </form>`
        }
    <//>`;
}
