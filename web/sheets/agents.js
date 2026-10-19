// Native Work Item execution and app-wide agent instructions, editable only by the owner.
import { Fragment } from "preact";
import { useEffect, useRef, useState } from "preact/hooks";
import { api, store } from "../store.js";
import { ThreadTypeTag } from "../thread-type.js";
import { html, Icon, Loader, Switch } from "../ui.js";

function AgentPrompt({ agent, maxLength }) {
    const [savedPrompt, setSavedPrompt] = useState(agent.prompt);
    const [draft, setDraft] = useState(agent.prompt);
    const [busy, setBusy] = useState(false);
    const [saved, setSaved] = useState(false);
    const [problem, setProblem] = useState(null);
    const [typing, setTyping] = useState(false);
    const [editing, setEditing] = useState(false);
    const input = useRef(null);
    const wasEditing = useRef(false);
    const dirty = draft !== savedPrompt;
    const fieldId = `agent-prompt-${agent.type}`;
    const noteId = `${fieldId}-note`;

    useEffect(() => {
        if (editing || wasEditing.current) {
            input.current?.focus();
        }

        wasEditing.current = editing;
    }, [editing]);

    const change = (text, fromInput = false) => {
        setDraft(text);
        setSaved(false);
        setProblem(null);
        setTyping(fromInput);
    };

    const reveal = (event) => {
        if (event.pointerType === "mouse") {
            setTyping(false);
        }
    };

    const save = async (event) => {
        event.preventDefault();

        if (!editing || busy || store.state.me?.role !== "owner") {
            return;
        }

        setBusy(true);
        setSaved(false);
        setProblem(null);
        setTyping(false);

        try {
            const result = await api(`agents/${agent.type}`, {
                prompt: draft,
                expectedPrompt: savedPrompt,
            });

            setSavedPrompt(result.prompt);
            setDraft(result.prompt);
            setSaved(true);
            setEditing(false);
        } catch (error) {
            setProblem(error.message);
        } finally {
            setBusy(false);
        }
    };

    return html`<form class="agent-prompt" onSubmit=${save} aria-labelledby=${`${fieldId}-title`}>
        <div class="agent-prompt-heading">
            <h4 id=${`${fieldId}-title`}>
                <span aria-hidden="true">
                    <${ThreadTypeTag} session=${{ threadType: agent.type }} iconOnly />
                </span>
                ${agent.name}
            </h4>
            <span class="muted small">
                ${dirty ? "Unsaved changes" : savedPrompt === agent.defaultPrompt ? "Default" : "Customized"}
            </span>
        </div>
        <p id=${noteId} class="muted small">${agent.description}</p>
        <div class="field">
            <label class="label" for=${fieldId}>System prompt</label>
            <div
                class=${`agent-prompt-editor${typing ? " typing" : ""}`}
                onPointerEnter=${reveal}
                onPointerMove=${reveal}
            >
                <textarea
                    id=${fieldId}
                    ref=${input}
                    name=${`${agent.type}-prompt`}
                    aria-describedby=${noteId}
                    rows="9"
                    maxlength=${maxLength}
                    spellcheck=${false}
                    required
                    disabled=${busy}
                    readonly=${!editing}
                    value=${draft}
                    onInput=${(event) => {
                        if (editing && !busy) {
                            change(event.currentTarget.value, true);
                        }
                    }}
                    onBlur=${() => setTyping(false)}
                ></textarea>
                <div
                    class="agent-prompt-actions"
                    role="group"
                    aria-label=${`${agent.name} prompt actions`}
                >
                    ${
                        !editing
                            ? html`<button
                        class="icon-button"
                        type="button"
                        aria-label=${`Edit ${agent.name} prompt`}
                        title="Edit prompt"
                        onClick=${() => setEditing(true)}
                    >
                        <${Icon} name="pencil" size=${16} />
                    </button>`
                            : html`
                        <button
                            class="icon-button agent-prompt-save"
                            type="submit"
                            aria-label=${`Save ${agent.name} prompt`}
                            title=${busy ? "Saving…" : "Save prompt"}
                            aria-busy=${busy ? "true" : undefined}
                            disabled=${busy || !dirty || draft.trim() === "" || draft.length > maxLength}
                        >
                            <${Icon} name=${busy ? "reload" : "check"} size=${16} />
                        </button>
                        <button
                            class="icon-button"
                            type="button"
                            aria-label=${`Restore ${agent.name} default prompt`}
                            title="Restore default"
                            disabled=${busy || draft === agent.defaultPrompt}
                            onClick=${() => change(agent.defaultPrompt)}
                        >
                            <${Icon} name="reload" size=${16} />
                        </button>
                        <button
                            class="icon-button"
                            type="button"
                            aria-label=${`Cancel editing ${agent.name} prompt`}
                            title="Cancel editing"
                            disabled=${busy}
                            onClick=${() => {
                                change(savedPrompt);
                                setEditing(false);
                            }}
                        >
                            <${Icon} name="close" size=${16} />
                        </button>
                    `
                    }
                </div>
            </div>
        </div>
        ${problem && html`<div class="error-box" role="alert">${problem}</div>`}
        ${saved && html`<p class="muted small" role="status">${agent.name} prompt saved.</p>`}
    </form>`;
}

function WorkItemExecution() {
    const enabled = store.state.server?.workItemsEnabled;
    const [busy, setBusy] = useState(false);
    const [problem, setProblem] = useState(null);

    const change = async () => {
        if (busy || store.state.me?.role !== "owner") {
            return;
        }

        setBusy(true);
        setProblem(null);

        try {
            await api("agents", { workItemsEnabled: !enabled });
        } catch (error) {
            setProblem(error.message);
        } finally {
            setBusy(false);
        }
    };

    if (typeof enabled !== "boolean") {
        return null;
    }

    return html`<div class="setting">
        <div class="grow">
            <div class="small">Work Item execution</div>
            <div class="muted small">
                ${busy ? "Saving…" : enabled ? "Enabled." : "Paused."} Pausing blocks new handoffs and managed writes, without hiding profiles or history. Ordinary Chat and Agent Teams remain available.
            </div>
            ${problem && html`<div class="error-box" role="alert">${problem} Reload the page to check whether the change was saved.</div>`}
        </div>
        <${Switch}
            on=${enabled}
            disabled=${busy}
            label=${`Work Item execution: ${enabled ? "enabled" : "paused"}`}
            onChange=${change}
        />
    </div>`;
}

export function AgentsSettings() {
    const owner = store.state.me?.role === "owner";
    const supported = store.state.server?.agentSettings >= 1;
    const [data, setData] = useState(null);
    const [problem, setProblem] = useState(null);
    const [loading, setLoading] = useState(false);

    const load = async () => {
        setLoading(true);
        setProblem(null);

        try {
            const result = await api("agents");

            if (store.state.me?.role === "owner") {
                setData(result);
            }
        } catch (error) {
            setProblem(error.message);
        } finally {
            setLoading(false);
        }
    };

    useEffect(() => {
        if (owner && supported) {
            load();
        } else {
            setData(null);
        }
    }, [owner, supported]);

    if (!owner) {
        return html`<p class="muted small">Only the owner can manage Work Item execution and app-wide agent prompts.</p>`;
    }

    if (!supported) {
        return html`<p class="muted small">
            Restart the server (menu → Restart server) to edit agent prompts here.
        </p>`;
    }

    return html`<${Fragment}>
        <${WorkItemExecution} />
        <p class="muted small">
            These role-specific system prompts apply to every thread of that type, including delegated helpers, on the next model request. Shared instructions, safety rules and runtime permissions stay in effect. Session instructions remain separate.
        </p>
        <p class="muted small">
            Use the pencil to edit a prompt. Restore default fills the editor; Save prompt applies the change.
        </p>
        ${loading && html`<${Loader} label="Loading agents" />`}
        ${
            problem &&
            html`<div class="error-box" role="alert">
            ${problem}
            <button class="button small" disabled=${loading} onClick=${load}>Retry</button>
        </div>`
        }
        <div class="agent-prompts">
            ${data?.agents.map(
                (agent) => html`<${AgentPrompt}
                key=${agent.type}
                agent=${agent}
                maxLength=${data.maxPromptLength}
            />`,
            )}
        </div>
    <//>`;
}
