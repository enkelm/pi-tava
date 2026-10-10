// Import a local Chromium-family profile as the shared, persistent app-browser default.
import { useEffect, useState } from "preact/hooks";
import { api, store } from "../store.js";
import { html, Spinner } from "../ui.js";

export function BrowserSettings() {
    const owner = store.state.me?.role === "owner";
    const [data, setData] = useState(null);
    const [selected, setSelected] = useState("");
    const [acknowledged, setAcknowledged] = useState(false);
    const [busy, setBusy] = useState(false);
    const [problem, setProblem] = useState(null);
    const [message, setMessage] = useState(null);
    const [path, setPath] = useState("");
    const [executable, setExecutable] = useState("");

    const load = async (custom = false) => {
        setBusy(true);
        setProblem(null);

        try {
            const result = await api(
                custom ? "browser-profiles/discover" : "browser-profiles",
                custom ? { path, executable } : undefined,
            );

            setData(result);
            setSelected("");
            setAcknowledged(false);
        } catch (error) {
            setProblem(error.message);
        } finally {
            setBusy(false);
        }
    };

    useEffect(() => {
        if (owner) {
            void load();
        }
    }, [owner]);

    if (!owner) {
        return html`<p class="muted">Only the owner can import or change browser profiles.</p>`;
    }

    const source = data?.profiles.find((profile) => profile.id === selected);

    const change = async (id) => {
        setBusy(true);
        setProblem(null);
        setMessage(null);

        try {
            const result = await api("browser-profiles/default", { id, confirm: true });

            setData((previous) => ({ ...previous, defaultProfile: result.defaultProfile }));
            setAcknowledged(false);
            setSelected("");
            setMessage(
                id === null
                    ? "Clean, isolated sessions are now the default. Reopen the Browser panel."
                    : "Profile imported and set as the app default. Reopen the Browser panel to use it.",
            );
        } catch (error) {
            setProblem(error.message);
        } finally {
            setBusy(false);
        }
    };

    return html`<div class="browser-profile-settings">
        <div class="group">
            <div class="label">App browser default</div>
            <p>
                <strong>${!data ? (busy ? "Loading…" : "Default unavailable") : data.defaultProfile ? `${data.defaultProfile.browser} · ${data.defaultProfile.label}` : "Clean, isolated sessions"}</strong>
            </p>
            <p class="muted small">
                ${!data ? "If this server has just been updated, restart it to enable profile importing." : data.defaultProfile ? "All conversations share this imported copy’s cookies and site storage. Changes stay in the app; your original profile is untouched." : "Each conversation starts with its own temporary cookies and site storage."}
            </p>
            ${
                data?.defaultProfile &&
                html`<button class="button" disabled=${busy} onClick=${() => change(null)}>
                    Use clean sessions instead
                </button>`
            }
        </div>
        <div class="group">
            <div class="group-title">Import from a browser</div>
            <p class="muted small">
                Importing supports Chrome, Chromium, Brave, Edge and Vivaldi profiles on macOS and Linux. Profiles are on the server, not this device. Firefox, Safari, Windows and Snap imports are not supported yet.
            </p>
            ${busy && !data && html`<${Spinner} label="Looking for browser profiles" />`}
            ${
                data &&
                html`<label class="field">
                    <span class="label">Browser profile</span>
                    <select
                        value=${selected}
                        disabled=${busy}
                        onChange=${(event) => {
                            setSelected(event.currentTarget.value);
                            setAcknowledged(false);
                            setMessage(null);
                        }}
                    >
                        <option value="">Choose a profile…</option>
                        ${data.profiles.map(
                            (profile) => html`<option key=${profile.id} value=${profile.id}>
                                ${profile.browser} · ${profile.label} (${profile.profile})
                            </option>`,
                        )}
                    </select>
                </label>`
            }
            ${
                data?.profiles.length === 0 &&
                html`<p class="muted small">
                    No supported profiles found. Try another profile location below, or install its browser on this machine.
                </p>`
            }
            <button class="button small" disabled=${busy} onClick=${() => load()}>Refresh profiles</button>
            ${
                source &&
                html`<div class="group">
                    <p class="muted small">
                        Quit ${source.browser} before importing. Cookies, site storage, bookmarks and history are copied. Passwords, autofill, extensions and open tabs are not. Some sites may require signing in again; the OS may ask for keychain access.
                    </p>
                    <label class="check">
                        <input
                            type="checkbox"
                            checked=${acknowledged}
                            disabled=${busy}
                            onChange=${(event) => setAcknowledged(event.currentTarget.checked)}
                        />
                        <span>I understand that Pi and people using the app browser can access these signed-in accounts in every conversation. Switching closes all app-browser pages.</span>
                    </label>
                    <button
                        class="button primary"
                        disabled=${busy || !acknowledged}
                        onClick=${() => change(selected)}
                    >
                        ${busy ? "Importing…" : "Import & set as app default"}
                    </button>
                </div>`
            }
        </div>
        <details class="group">
            <summary>Another profile location</summary>
            <form onSubmit=${(event) => {
                event.preventDefault();
                void load(true);
            }}>
                <p class="muted small">
                    Use a Chromium-family user-data folder or a profile folder, and the executable for that same browser. Paths must be absolute and on the server.
                </p>
                <label class="field">
                    <span class="label">Profile location</span>
                    <input
                        value=${path}
                        required
                        disabled=${busy}
                        placeholder="/path/to/User Data or Default"
                        onInput=${(event) => setPath(event.currentTarget.value)}
                    />
                </label>
                <label class="field">
                    <span class="label">Browser executable</span>
                    <input
                        value=${executable}
                        required
                        disabled=${busy}
                        placeholder="/path/to/chrome"
                        onInput=${(event) => setExecutable(event.currentTarget.value)}
                    />
                </label>
                <button class="button" type="submit" disabled=${busy || !path || !executable}>
                    Find profiles here
                </button>
            </form>
        </details>
        ${problem && html`<div class="error-box" role="alert">${problem}</div>`}
        ${message && html`<p role="status">${message}</p>`}
    </div>`;
}
