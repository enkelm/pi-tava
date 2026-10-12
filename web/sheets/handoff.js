// A human chooses a valid path; the agent owns the brief, completion summary and recommendation.
import { useEffect, useRef, useState } from "preact/hooks";
import { HANDOFF_LABELS, handoffOptions, preferredHandoff } from "../handoffs.js";
import {
    actions,
    canSteer,
    closeSheet,
    handoffsAvailable,
    navigate,
    store,
    uid,
} from "../store.js";
import { ThreadTypeTag } from "../thread-type.js";
import { html, Loader, Sheet } from "../ui.js";

const keyOf = (option) => `${option.targetType}:${option.relationship}`;
const DESCRIPTIONS = {
    reviewer: "Independent review and fixes in this checkout. This thread becomes read-only.",
    land: "Review passed. Integrate and verify locally; no external delivery.",
    publish: "Optional external delivery. Each action requires separate human approval.",
    worker: "More implementation is needed. Continue in a fresh worker; this thread becomes read-only.",
};

export function HandoffSheet({ id, option: initialOption }) {
    const [data, setData] = useState(null);
    const [loading, setLoading] = useState(true);
    const [choice, setChoice] = useState(initialOption ? keyOf(initialOption) : "");
    const [busy, setBusy] = useState(false);
    const [error, setError] = useState("");
    const [retry, setRetry] = useState(0);
    const submitting = useRef(false);
    const request = useRef({ id: uid(), signature: null });
    const type = store.state.sessions.find((each) => each.id === id)?.threadType ?? "worker";

    useEffect(() => {
        let stopped = false;

        setLoading(true);
        setError("");
        actions.handoffs(id).then(
            (value) => {
                if (stopped) {
                    return;
                }

                const options = handoffOptions(value, type);

                setData(value);
                setLoading(false);
                setChoice((old) =>
                    options.some((each) => keyOf(each) === old)
                        ? old
                        : keyOf(preferredHandoff(value, type) ?? options[0] ?? {}),
                );
            },
            (failure) => {
                if (!stopped) {
                    setError(failure.message);
                    setLoading(false);
                }
            },
        );

        return () => {
            stopped = true;
        };
    }, [id, type, retry]);

    if (!handoffsAvailable() || !canSteer()) {
        return null;
    }

    const options = handoffOptions(data, type);
    const selected = options.find((each) => keyOf(each) === choice);
    const valid = selected && !data.workflow.readOnly;
    const recommendation = [data?.workflow.proposal, ...(data?.workflow.recommendations ?? [])]
        .filter(Boolean)
        .find((each) => keyOf(each) === choice);

    const save = async (event) => {
        event.preventDefault();

        if (submitting.current || !valid) {
            return;
        }

        const opened = store.state.sheet;
        const payload = {
            targetType: selected.targetType,
            relationship: selected.relationship,
        };
        const signature = JSON.stringify(payload);

        if (request.current.signature !== null && request.current.signature !== signature) {
            request.current.id = uid();
        }

        request.current.signature = signature;
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
            setError(`${failure.message} Retry to use the same handoff request.`);
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
            html`<form class="handoff-form" onSubmit=${save}>
            <fieldset aria-label="Next thread" disabled=${busy}>
                <div class="handoff-options">
                    ${options.map(
                        (each) => html`<label class="handoff-option">
                        <input
                            type="radio"
                            name="handoff-option"
                            value=${keyOf(each)}
                            checked=${choice === keyOf(each)}
                            disabled=${data.workflow.readOnly}
                            onChange=${() => setChoice(keyOf(each))}
                        />
                        <${ThreadTypeTag} session=${{ threadType: each.targetType }} iconOnly=${true} />
                        <span>
                            <strong>${HANDOFF_LABELS[each.targetType] ?? each.targetType}</strong>
                            ${each.targetType === "worker" && html`<span class="small muted">${each.relationship === "new-work" ? "New Work Item · linked to this one" : "More work · same Work Item"}</span>`}
                        </span>
                    </label>`,
                    )}
                </div>
                ${options.length === 0 && html`<p class="muted small">${data.workflow.readOnly ? "Open the active thread to continue this work." : "No handoff is ready. Ask the agent to finish its checks and prepare the next step."}</p>`}
                ${selected && html`<p class="small handoff-explanation">${selected.relationship === "new-work" ? "Begin separate work linked to this completed Work Item." : DESCRIPTIONS[selected.targetType]}</p>`}
                ${recommendation?.reason && html`<p class="small muted">${recommendation.reason}</p>`}
            </fieldset>
            ${error && html`<p class="error" role="alert">${error}</p>`}
            <div class="handoff-form-actions">
                <button class="button" type="button" disabled=${busy} onClick=${closeSheet}>Cancel</button>
                <button class="button primary" type="submit" disabled=${busy || !valid}>
                    ${busy ? "Starting…" : (HANDOFF_LABELS[selected?.targetType] ?? "Start thread")}
                </button>
            </div>
        </form>`
        }
    <//>`;
}
