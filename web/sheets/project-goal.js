// Manual names use the existing goal update action and take precedence over delayed AI naming.
import { useRef, useState } from "preact/hooks";
import { actions, canSteer, closeSheet, projectsAvailable, scoped, store } from "../store.js";
import { html, Sheet } from "../ui.js";

export function ProjectGoalSheet({ goalId }) {
    const goal = store.state.projectGoals.find((each) => each.id === goalId);
    const [name, setName] = useState(goal?.name ?? "");
    const [busy, setBusy] = useState(false);
    const [error, setError] = useState("");
    const submitting = useRef(false);

    if (!projectsAvailable() || !canSteer() || scoped()) {
        return null;
    }

    const save = async (event) => {
        event.preventDefault();

        if (submitting.current || !goal || !name.trim()) {
            return;
        }

        const opened = store.state.sheet;

        submitting.current = true;
        setBusy(true);
        setError("");

        try {
            await actions.updateProjectGoal(goalId, { name: name.trim() });

            if (store.state.sheet === opened) {
                closeSheet();
            }
        } catch (failure) {
            setError(failure.message ?? String(failure));
        } finally {
            submitting.current = false;
            setBusy(false);
        }
    };

    return html`<${Sheet} title="Rename goal" onClose=${busy ? () => {} : closeSheet}>
        <form class="project-goal-form" onSubmit=${save}>
            <label>
                <span class="label">Goal name</span>
                <input
                    aria-label="Goal name"
                    autofocus
                    value=${name}
                    maxlength="160"
                    disabled=${busy || !goal}
                    onInput=${(event) => {
                        setName(event.currentTarget.value);
                        setError("");
                    }}
                />
            </label>
            ${!goal && html`<p class="error" role="alert">This goal is no longer available.</p>`}
            ${error && html`<p class="error" role="alert">${error}</p>`}
            <div class="project-goal-actions">
                <button class="button" type="button" disabled=${busy} onClick=${closeSheet}>
                    Cancel
                </button>
                <button
                    class="button primary"
                    type="submit"
                    disabled=${busy || !goal || !name.trim()}
                >
                    ${busy ? "Saving…" : "Save"}
                </button>
            </div>
        </form>
    <//>`;
}
