// One working destination per thread. Local always means the Coop server, not this browser.
import { useEffect, useId, useState } from "preact/hooks";
import { api, store } from "./store.js";
import { html } from "./ui.js";
import { SshLogin } from "./ssh-login.js";

const recentKey = () => `pocket.sshFolders.${store.state.me?.id ?? "owner"}`;

export function recentSshFolders() {
    try {
        const saved = JSON.parse(localStorage.getItem(recentKey()) ?? "[]");

        return Array.isArray(saved)
            ? saved
                  .filter(
                      (item) => typeof item?.host === "string" && typeof item?.path === "string",
                  )
                  .slice(0, 12)
            : [];
    } catch {
        return [];
    }
}

export function rememberSshFolder(location, path) {
    if (location?.kind !== "ssh" || !location.host.trim() || !path) {
        return;
    }

    const host = location.host.trim();
    const recent = recentSshFolders().filter((item) => item.host !== host || item.path !== path);

    try {
        localStorage.setItem(recentKey(), JSON.stringify([{ host, path }, ...recent].slice(0, 12)));
    } catch {
        // Private browsing or full storage must not prevent working on the selected host.
    }
}

export function conversationLocation() {
    const { view, sessions, conversationId } = store.state;

    return (
        view.conversation?.location ??
        sessions.find((session) => session.id === conversationId)?.location ??
        null
    );
}

export function LocationPicker({
    location,
    onChange,
    onRecent,
    disabled = false,
    showLogin = true,
}) {
    const { server, me } = store.state;
    const remote = location?.kind === "ssh";
    const available = server?.sshWorkspaces >= 1;
    const canDiscover = me?.role === "owner";
    const recent = recentSshFolders();
    const [discovery, setDiscovery] = useState(null);
    const [refresh, setRefresh] = useState(0);
    const current = discovery?.userId === me?.id ? discovery : null;
    const hosts = current?.hosts ?? [];
    const hostList = useId();

    useEffect(() => {
        setDiscovery(null);

        if (!remote || !available || !canDiscover) {
            return;
        }

        const controller = new AbortController();
        const userId = me.id;
        const stillCurrent = () =>
            !controller.signal.aborted &&
            store.state.me?.id === userId &&
            store.state.me?.role === "owner";

        api("ssh-hosts", undefined, { signal: controller.signal }).then(
            (result) => {
                if (stillCurrent()) {
                    setDiscovery({ userId, ...result });
                }
            },
            () => {
                if (stillCurrent()) {
                    setDiscovery({ userId, error: true });
                }
            },
        );

        return () => controller.abort();
    }, [remote, available, canDiscover, me?.id, refresh]);

    if (!available && !remote) {
        return null;
    }

    return html`<div class="workspace-location">
        <label>
            <span class="label">Working location</span>
            <select
                aria-label="Working location"
                value=${remote ? "ssh" : "local"}
                disabled=${disabled}
                onChange=${(event) => onChange(event.currentTarget.value === "ssh" ? { kind: "ssh", host: "" } : null)}
            >
                <option value="local">Local · ${server?.hostName ?? "Coop server"}</option>
                <option value="ssh" disabled=${!available}>SSH…</option>
            </select>
        </label>
        ${
            remote &&
            html`<label>
            <span class="label">SSH host</span>
            <input
                class="mono"
                aria-label="SSH host"
                placeholder="devbox, user@host or ssh://user@host:port"
                list=${canDiscover && available ? hostList : undefined}
                value=${location.host}
                disabled=${disabled || !available}
                autocapitalize="off"
                autocomplete="off"
                spellcheck="false"
                onInput=${(event) => onChange({ kind: "ssh", host: event.currentTarget.value.trim() })}
            />
        </label>
        ${
            canDiscover &&
            available &&
            html`<datalist id=${hostList}>
            ${hosts.map((host) => html`<option value=${host} />`)}
        </datalist>`
        }
        ${current?.error && html`<button class="link small" type="button" disabled=${disabled} onClick=${() => setRefresh((value) => value + 1)}>Retry saved hosts</button>`}
        ${showLogin && html`<${SshLogin} host=${location.host} disabled=${disabled || !available} />`}`
        }
        ${remote && !available && html`<p class="error" role="status">Update the Coop server to use SSH.</p>`}
        ${
            onRecent &&
            recent.length > 0 &&
            html`<label>
            <span class="label">Recent SSH folders</span>
            <select
                aria-label="Recent SSH folders"
                value=""
                disabled=${disabled || !available}
                onChange=${(event) => {
                    const item = recent[Number(event.currentTarget.value)];

                    if (item) {
                        onRecent({ kind: "ssh", host: item.host }, item.path);
                    }
                }}
            >
                <option value="">Choose a recent destination…</option>
                ${recent.map((item, index) => html`<option value=${index}>${item.host} · ${item.path}</option>`)}
            </select>
        </label>`
        }
    </div>`;
}
