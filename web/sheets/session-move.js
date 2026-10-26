// The non-drag alternative uses exactly the same placement action as the sidebar drop targets.
import { useRef, useState } from "preact/hooks";
import { canMoveSessions, movableSessions, moveSessions, samePlacement } from "../session-moves.js";
import { closeSheet, handoffsAvailable, store } from "../store.js";
import { html, Sheet } from "../ui.js";

export function SessionMoveSheet({ ids }) {
    const catalogue = movableSessions();
    const sessions = ids.map((id) => catalogue.find((session) => session.id === id));
    const first = sessions[0];
    const workItem = ids.length === 1 && handoffsAvailable() && first?.workItemId;
    const common = sessions.every(
        (session) =>
            session &&
            first &&
            samePlacement(session, {
                projectId: first.projectId ?? null,
            }),
    );
    const [projectId, setProjectId] = useState(common ? (first?.projectId ?? "") : "");
    const [busy, setBusy] = useState(false);
    const [error, setError] = useState("");
    const remaining = useRef(ids);
    const submitting = useRef(false);
    const { projects, projectsLoaded } = store.state;
    const project = projects.find((each) => each.id === projectId);
    const valid = !projectId || project;

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
                label: project?.name ?? "No project",
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
        title=${workItem ? "Move Work Item" : ids.length === 1 ? "Move session" : `Move ${ids.length} items`}
        onClose=${busy ? () => {} : closeSheet}
    >
        <form class="session-move-form" onSubmit=${save}>
            <p class="muted small">${workItem ? "All threads in this Work Item move together. " : "Work Item members move together. "}Only project changes; history, thread type and working directory stay the same.</p>
            <label>
                <span class="label">Project</span>
                <select
                    aria-label="Project"
                    value=${projectId}
                    disabled=${busy || !projectsLoaded}
                    onChange=${(event) => {
                        setProjectId(event.currentTarget.value);
                        setError("");
                    }}
                >
                    <option value="">No project</option>
                    ${projects.map((each) => html`<option key=${each.id} value=${each.id}>${each.name}</option>`)}
                </select>
            </label>
            ${!projectsLoaded && html`<p class="muted small" role="status">Loading projects…</p>`}
            ${!valid && html`<p class="error" role="alert">Choose an available project.</p>`}
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
