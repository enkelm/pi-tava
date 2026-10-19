// The inherited folder is one quiet row; destination controls exist only while changing it.
import { useId, useState } from "preact/hooks";
import { useBack } from "./back.js";
import { store } from "./store.js";
import { html, Icon, shortPath } from "./ui.js";
import { LocationPicker } from "./workspace-location.js";
import { FolderPicker } from "./sheets/folder.js";

export function WorkspaceField({
    location,
    cwd,
    onChange,
    onReset,
    disabled = false,
    visible = true,
    label = "Working directory",
    children,
}) {
    const [editing, setEditing] = useState(false);
    const [browsing, setBrowsing] = useState(false);
    const id = useId();
    const remote = location?.kind === "ssh";
    const server = store.state.server;
    const editable = store.state.me?.role === "owner";
    const ready = !remote || (server?.sshWorkspaces >= 1 && location.host.trim());

    const close = () => {
        setBrowsing(false);
        setEditing(false);
    };

    useBack(visible && editable && editing, close);
    useBack(visible && editable && browsing, () => setBrowsing(false));

    const change = (next, path) => {
        if (!editable) {
            return;
        }

        const same = JSON.stringify(next ?? null) === JSON.stringify(location ?? null);

        setBrowsing(false);
        onChange(next, path ?? (same ? cwd : next ? "~" : (server?.defaultCwd ?? "~")));
    };

    return html`<div class="workspace-field">
        <div class="session-path" aria-label=${label}>
            <span class="workspace-field-title mono" title=${remote ? `${location.host} · ${cwd}` : cwd}>
                <${Icon} name=${remote ? "monitor" : "folder"} size=${14} />
                ${remote ? `${location.host} · ` : ""}${shortPath(cwd, remote ? undefined : server?.home)}
            </span>
            ${
                editable &&
                html`<button
                    type="button"
                    class="button small"
                    disabled=${disabled || (editing && (!ready || !cwd.trim()))}
                    aria-expanded=${editing}
                    aria-controls=${id}
                    onClick=${() => (editing ? close() : setEditing(true))}
                >
                    ${editing ? "Done" : "Change"}
                </button>`
            }
        </div>
        ${
            editable &&
            editing &&
            html`<div class="workspace-field-options" id=${id}>
            <${LocationPicker}
                location=${location}
                disabled=${disabled}
                showLogin=${!browsing}
                onChange=${change}
                onRecent=${(next, path) => {
                    change(next, path);
                    close();
                }}
            />
            <label>
                <span class="label">${label}</span>
                <div class="row">
                    <input
                        class="mono"
                        aria-label=${label}
                        value=${cwd}
                        disabled=${disabled}
                        autocapitalize="off"
                        autocomplete="off"
                        spellcheck="false"
                        onInput=${(event) => {
                            setBrowsing(false);
                            onChange(location, event.currentTarget.value);
                        }}
                    />
                    <button
                        type="button"
                        class="button"
                        disabled=${disabled || !ready || !cwd.trim()}
                        aria-expanded=${browsing}
                        onClick=${() => setBrowsing(!browsing)}
                    >
                        ${browsing ? "Hide folders" : "Browse"}
                    </button>
                </div>
            </label>
            ${
                browsing &&
                html`<${FolderPicker}
                mode="pick"
                location=${location}
                initialPath=${cwd}
                onCancel=${() => setBrowsing(false)}
                onUse=${(path) => {
                    onChange(location, path);
                    close();
                }}
            />`
            }
            ${children}
            ${
                onReset &&
                html`<button type="button" class="button small" disabled=${disabled} onClick=${() => {
                    onReset();
                    close();
                }}>Use default folder</button>`
            }
        </div>`
        }
    </div>`;
}
