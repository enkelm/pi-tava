// A project owns its name and default working directory, not any session's current directory.
import { useRef, useState } from "preact/hooks";
import { useBack } from "../back.js";
import { actions, closeSheet, projectsAvailable, store, uid } from "../store.js";
import { html, Sheet } from "../ui.js";
import { FolderPicker } from "./folder.js";

export function ProjectForm({
    project = null,
    onSaved,
    onCancel,
    visible = true,
    onBusyChange = () => {},
}) {
    const [name, setName] = useState(project?.name ?? "");
    const [cwd, setCwd] = useState(project?.cwd ?? store.state.server?.defaultCwd ?? "~");
    const [browse, setBrowse] = useState(false);
    const [busy, setBusy] = useState(false);
    const [error, setError] = useState("");
    const requestId = useRef(uid());

    useBack(visible && browse, () => setBrowse(false));

    const save = async (event) => {
        event.preventDefault();

        if (busy || !name.trim() || !cwd.trim()) {
            return;
        }

        setBusy(true);
        onBusyChange(true);
        setError("");

        try {
            const request = { name: name.trim(), cwd: cwd.trim() };
            const result = project
                ? await actions.updateProject(project.id, request)
                : await actions.createProject({ ...request, requestId: requestId.current });

            await actions.loadProjects();
            onSaved?.(project?.id ?? result.id);
        } catch (failure) {
            setError(failure.message ?? String(failure));
        } finally {
            setBusy(false);
            onBusyChange(false);
        }
    };

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
        <label>
            <span class="label">Default working directory</span>
            <div class="row">
                <input
                    class="mono"
                    aria-label="Default working directory"
                    value=${cwd}
                    disabled=${busy}
                    autocapitalize="off"
                    autocomplete="off"
                    spellcheck="false"
                    onInput=${(event) => {
                        setCwd(event.currentTarget.value);
                        requestId.current = uid();
                    }}
                />
                <button
                    class="button"
                    type="button"
                    disabled=${busy}
                    onClick=${() => setBrowse(!browse)}
                >
                    ${browse ? "Hide" : "Browse"}
                </button>
            </div>
        </label>
        ${
            project &&
            html`<p class="muted small">This changes the default for new threads. Existing threads keep their working directory.</p>`
        }
        ${error && html`<p class="error" role="alert">${error}</p>`}
        <div class="row">
            <button
                class="button primary"
                type="submit"
                disabled=${busy || !name.trim() || !cwd.trim()}
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
    </form>
    ${
        browse &&
        html`<${FolderPicker}
            mode="pick"
            initialPath=${cwd}
            onUse=${(path) => {
                setCwd(path);
                setBrowse(false);
                requestId.current = uid();
            }}
        />`
    }`;
}

export function ProjectSheet({ projectId }) {
    if (!projectsAvailable()) {
        return null;
    }

    const project = store.state.projects.find((each) => each.id === projectId);

    return html`<${Sheet} title=${project ? "Edit project" : "New Project"} onClose=${closeSheet}>
        <${ProjectForm} project=${project} onSaved=${closeSheet} onCancel=${closeSheet} />
    <//>`;
}
