// A project owns its name and default destination, not any existing thread's directory.
import { useRef, useState } from "preact/hooks";
import { actions, closeSheet, projectsAvailable, store, uid } from "../store.js";
import { html, Sheet } from "../ui.js";
import { rememberSshFolder } from "../workspace-location.js";
import { WorkspaceField } from "../workspace-field.js";

export function ProjectForm({
    project = null,
    onSaved,
    onCancel,
    visible = true,
    onBusyChange = () => {},
}) {
    const owner = store.state.me?.role === "owner";
    const [name, setName] = useState(project?.name ?? "");
    const [cwd, setCwd] = useState(project?.cwd ?? store.state.server?.defaultCwd ?? "~");
    const [location, setLocation] = useState(project?.location ?? null);
    const locationReady =
        location?.kind !== "ssh" ||
        (store.state.server?.sshWorkspaces >= 1 && location.host.trim());
    const [busy, setBusy] = useState(false);
    const [error, setError] = useState("");
    const requestId = useRef(uid());

    const save = async (event) => {
        event.preventDefault();

        if (!owner || busy || !locationReady || !name.trim() || !cwd.trim()) {
            return;
        }

        setBusy(true);
        onBusyChange(true);
        setError("");

        try {
            const request = { name: name.trim(), cwd: cwd.trim(), location };
            const result = project
                ? await actions.updateProject(project.id, request)
                : await actions.createProject({ ...request, requestId: requestId.current });

            await actions.loadProjects();
            rememberSshFolder(location, cwd.trim());
            onSaved?.(project?.id ?? result.id);
        } catch (failure) {
            setError(failure.message ?? String(failure));
        } finally {
            setBusy(false);
            onBusyChange(false);
        }
    };

    if (!owner) {
        return html`<p class="muted small">Only the owner can create projects or change their machine and folder.</p>`;
    }

    return html`<form class="project-form" onSubmit=${save}>
        <label>
            <span class="label">Project name</span>
            <input
                aria-label="Project name"
                value=${name}
                maxlength="160"
                disabled=${busy}
                onInput=${(event) => {
                    setName(event.currentTarget.value);
                    requestId.current = uid();
                }}
            />
        </label>
        <${WorkspaceField}
            label="Default working directory"
            location=${location}
            cwd=${cwd}
            visible=${visible}
            disabled=${busy}
            onChange=${(next, path) => {
                setLocation(next);
                setCwd(path);
                setError("");
                requestId.current = uid();
            }}
        />
        ${error && html`<p class="error" role="alert">${error}</p>`}
        <div class="row">
            <button
                class="button primary"
                type="submit"
                disabled=${busy || !locationReady || !name.trim() || !cwd.trim()}
            >
                ${busy ? "Saving…" : project ? "Save project" : "Create project"}
            </button>
            ${
                onCancel &&
                html`<button class="button" type="button" disabled=${busy} onClick=${onCancel}>
                Cancel
            </button>`
            }
        </div>
    </form>`;
}

export function ProjectSheet({ projectId }) {
    if (!projectsAvailable() || store.state.me?.role !== "owner") {
        return null;
    }

    const project = store.state.projects.find((each) => each.id === projectId);

    return html`<${Sheet} title=${project ? "Edit project" : "New Project"} onClose=${closeSheet}>
        <${ProjectForm} project=${project} onSaved=${closeSheet} onCancel=${closeSheet} />
    <//>`;
}
