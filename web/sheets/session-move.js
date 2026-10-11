// The non-drag alternative uses exactly the same placement action as the sidebar drop targets.
import { useRef, useState } from "preact/hooks";
import { canMoveSessions, moveSessions, samePlacement } from "../session-moves.js";
import { closeSheet, store } from "../store.js";
import { html, Sheet } from "../ui.js";

export function SessionMoveSheet({ ids }) {
    const sessions = ids.map((id) => store.state.sessions.find((session) => session.id === id));
    const first = sessions[0];
    const common = sessions.every(
        (session) =>
            session &&
            first &&
            samePlacement(session, {
                projectId: first.projectId ?? null,
                goalId: first.goalId ?? null,
            }),
    );
    const [projectId, setProjectId] = useState(common ? (first?.projectId ?? "") : "");
    const [goalId, setGoalId] = useState(common ? (first?.goalId ?? "") : "");
    const [busy, setBusy] = useState(false);
    const [error, setError] = useState("");
    const remaining = useRef(ids);
    const submitting = useRef(false);
    const { projects, projectGoals, projectsLoaded } = store.state;
    const goals = projectGoals.filter((goal) => goal.projectId === projectId && !goal.archived);
    const project = projects.find((each) => each.id === projectId);
    const goal = goals.find((each) => each.id === goalId);
    const valid = (!projectId || project) && (!goalId || goal);

    if (!canMoveSessions()) {
        return null;
    }

    const save = async (event) => {
        event.preventDefault();

        if (submitting.current || !valid) {
            return;
        }

        const opened = store.state.sheet;

        submitting.current = true;
        setBusy(true);
        setError("");

        try {
            const result = await moveSessions(remaining.current, {
                projectId: projectId || null,
                goalId: goalId || null,
                label: goal ? `${project.name} / ${goal.name}` : (project?.name ?? "No project"),
            });

            if (store.state.sheet !== opened) {
                return;
            }

            if (result.error) {
                remaining.current = result.failed;
                setError(result.error);
            } else {
                closeSheet();
            }
        } finally {
            submitting.current = false;
            setBusy(false);
        }
    };

    return html`<${Sheet}
        title=${ids.length === 1 ? "Move session" : `Move ${ids.length} sessions`}
        onClose=${busy ? () => {} : closeSheet}
    >
        <form class="session-move-form" onSubmit=${save}>
            <p class="muted small">Only the project and goal change. History, thread type and working directory stay the same.</p>
            <label>
                <span class="label">Project</span>
                <select
                    aria-label="Project"
                    value=${projectId}
                    disabled=${busy || !projectsLoaded}
                    onChange=${(event) => {
                        setProjectId(event.currentTarget.value);
                        setGoalId("");
                        setError("");
                    }}
                >
                    <option value="">No project</option>
                    ${projects.map((each) => html`<option key=${each.id} value=${each.id}>${each.name}</option>`)}
                </select>
            </label>
            ${
                projectId &&
                html`<label>
                <span class="label">Goal</span>
                <select
                    aria-label="Goal"
                    value=${goalId}
                    disabled=${busy}
                    onChange=${(event) => {
                        setGoalId(event.currentTarget.value);
                        setError("");
                    }}
                >
                    <option value="">No goal</option>
                    ${goals.map((each) => html`<option key=${each.id} value=${each.id}>${each.name}</option>`)}
                </select>
            </label>`
            }
            ${!projectsLoaded && html`<p class="muted small" role="status">Loading projects…</p>`}
            ${!valid && html`<p class="error" role="alert">Choose an available project and goal.</p>`}
            ${error && html`<p class="error" role="alert">${error}</p>`}
            <div class="session-move-actions">
                <button class="button" type="button" disabled=${busy} onClick=${closeSheet}>
                    Cancel
                </button>
                <button
                    class="button primary"
                    type="submit"
                    disabled=${busy || !valid || !projectsLoaded}
                >
                    ${busy ? "Moving…" : "Move"}
                </button>
            </div>
        </form>
    <//>`;
}
