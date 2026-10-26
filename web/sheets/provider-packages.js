// Owner-managed Pi provider packages. Selection and installation never activate code in this process.
import { useEffect, useRef, useState } from "preact/hooks";
import { api, store } from "../store.js";
import { html, Loader, Switch } from "../ui.js";

function trust(action, name) {
    return confirm(
        `${action} ${name}?\n\nThird-party provider packages run with the server's rights and can access provider credentials. Only use packages you trust. Changes take effect after you restart the server; Pi's own package enablement stays unchanged.`,
    );
}

function PackageConfiguration({ pkg, busy, change }) {
    const [baseUrl, setBaseUrl] = useState(pkg.settings?.baseUrl ?? "");
    const [aliases, setAliases] = useState(
        Object.entries(pkg.settings?.aliases ?? {})
            .map(([name, url]) => `${name}=${url}`)
            .join("\n"),
    );
    const [problem, setProblem] = useState(null);

    const save = (event) => {
        event.preventDefault();
        setProblem(null);

        const entries = aliases.split("\n").filter((line) => line.trim());
        const mapping = {};

        for (const line of entries) {
            const separator = line.indexOf("=");
            const name = line.slice(0, separator).trim();
            const url = line.slice(separator + 1).trim();

            if (separator < 1 || !url || Object.hasOwn(mapping, name)) {
                setProblem("Use one unique alias=https://public-url per line.");

                return;
            }

            mapping[name] = url;
        }

        void change(
            {
                action: "configure",
                name: pkg.name,
                settings: { baseUrl: baseUrl.trim() || undefined, aliases: mapping },
            },
            "Public settings saved. Restart the server to apply them.",
        );
    };

    return html`<details class="group">
        <summary>Public provider settings</summary>
        <form onSubmit=${save}>
            <p class="muted small">
                HTTPS URLs only, without credentials or query parameters. Once active, use the provider's sign-in controls above for credentials.
            </p>
            <label class="field">
                <span class="label">Public base URL</span>
                <input
                    type="url"
                    value=${baseUrl}
                    disabled=${busy}
                    placeholder="https://your-provider.example"
                    onInput=${(event) => setBaseUrl(event.currentTarget.value)}
                />
            </label>
            <label class="field">
                <span class="label">Aliases (one alias=URL per line)</span>
                <textarea
                    rows="3"
                    value=${aliases}
                    disabled=${busy}
                    placeholder="team=https://your-provider.example"
                    onInput=${(event) => setAliases(event.currentTarget.value)}
                />
            </label>
            ${problem && html`<p class="warn small" role="alert">${problem}</p>`}
            <button class="button small" disabled=${busy} type="submit">Save public settings</button>
        </form>
    </details>`;
}

export function ProviderPackagesSettings() {
    const owner = store.state.me?.role === "owner";
    const supported = store.state.server?.providerPackages >= 1;
    const [data, setData] = useState(null);
    const [busy, setBusy] = useState(null);
    const [problem, setProblem] = useState(null);
    const [message, setMessage] = useState(null);
    const [source, setSource] = useState("");
    const alive = useRef(false);
    const locked = useRef(false);

    const load = async () => {
        if (locked.current) {
            return;
        }

        locked.current = true;
        setBusy("Loading packages…");
        setProblem(null);

        try {
            const result = await api("provider-packages");

            if (alive.current) {
                setData(result);
            }
        } catch (error) {
            if (alive.current) {
                setProblem(error.message);
            }
        } finally {
            locked.current = false;

            if (alive.current) {
                setBusy(null);
            }
        }
    };

    useEffect(() => {
        alive.current = owner && supported;

        if (alive.current) {
            void load();
        }

        return () => {
            alive.current = false;
        };
    }, [owner, supported]);

    if (!owner || !supported) {
        return null;
    }

    const change = async (body, success, progress = "Saving package selection…") => {
        if (locked.current || store.state.me?.role !== "owner") {
            return;
        }

        locked.current = true;
        setBusy(progress);
        setProblem(null);
        setMessage(null);

        try {
            const result = await api("provider-packages", body);

            if (alive.current) {
                setData(result);
                setMessage(success);
            }
        } catch (error) {
            if (alive.current) {
                setProblem(error.message);
            }
        } finally {
            locked.current = false;

            if (alive.current) {
                setBusy(null);
            }
        }
    };

    const toggleModule = () => {
        if (!data.enabled && !trust("Enable", "Pi provider compatibility")) {
            return;
        }

        void change(
            {
                action: "module",
                enabled: !data.enabled,
                ...(!data.enabled ? { trusted: true } : {}),
            },
            "Compatibility setting saved. Restart the server to apply it.",
        );
    };

    const togglePackage = (pkg) => {
        if (!pkg.enabled && !trust("Enable", pkg.name)) {
            return;
        }

        void change(
            {
                action: "enable",
                name: pkg.name,
                enabled: !pkg.enabled,
                ...(!pkg.enabled ? { trusted: true } : {}),
            },
            "Package selection saved. Restart the server to apply it.",
        );
    };

    const install = (event) => {
        event.preventDefault();

        const exactSource = source.trim();

        if (!exactSource || !trust("Install", exactSource)) {
            return;
        }

        void change(
            { action: "install", source: exactSource, trusted: true },
            "Package installed and staged. Restart the server to apply the selection.",
            "Installing package on the server…",
        );
    };

    const packages = data?.packages ?? [];
    const available = (data?.available ?? []).filter(
        (pkg) => !packages.some((managed) => managed.name === pkg.name),
    );

    return html`<section class="provider-packages browser-profile-settings" aria-label="Provider packages">
        ${
            (data?.recoveryRequired || store.state.server?.providerRecovery) &&
            html`<div class="error-box" role="alert">
                Durable work is paused. Fix or disable provider compatibility, then restart.
            </div>`
        }
        <details class="group">
            <summary>Provider packages</summary>
            <div class="browser-profile-settings">
                <div class="group">
                    <p class="muted small">
                        Discovered on the server, not this device. pi-tava's selection is independent of Pi's own package enablement.
                    </p>
                    <p class="warn small">
                        Third-party packages run with the server's rights and can access provider credentials. Only enable packages you trust.
                    </p>
                    <p class="muted small">
                        API-key chat only. While enabled, Coop ignores <span class="mono">models.json</span> custom models/overrides.
                    </p>
                    ${
                        data &&
                        html`<div class="setting">
                            <div class="grow">
                                <div>Pi provider compatibility</div>
                                <div class="muted small">
                                    ${data.activeEnabled ? "Active in this server process." : "Not active in this server process."}
                                </div>
                            </div>
                            <${Switch}
                                on=${data.enabled}
                                disabled=${busy !== null}
                                label=${`Pi provider compatibility: ${data.enabled ? "on" : "off"}`}
                                onChange=${toggleModule}
                            />
                        </div>`
                    }
                    ${
                        data?.restartRequired &&
                        html`<p class="warn small" role="status">
                            Changes queued. Restart the server from the menu to apply them. Running providers stay unchanged until then.
                        </p>`
                    }
                    ${!data && busy && html`<${Loader} label="Loading provider packages" />`}
                </div>
                ${
                    data &&
                    html`<div class="group">
                        <div class="group-title">Managed packages</div>
                        ${packages.length === 0 && html`<p class="muted small">No managed provider packages yet. Select a discovered package or add an exact npm release below.</p>`}
                        ${packages.map(
                            (pkg) => html`<div class="extension" key=${pkg.id}>
                            <div class="extension-main">
                                <div class="extension-title">${pkg.name}</div>
                                <div class="muted small mono">
                                    Selected: ${pkg.version ?? pkg.installedVersion ?? "unknown"} · Active: ${pkg.activeVersion ?? "none"}
                                </div>
                                ${pkg.source && html`<div class="muted small mono">${pkg.source}</div>`}
                                <div class="small">
                                    ${pkg.status ?? (pkg.active ? "Active" : pkg.enabled ? "Selected · restart required" : "Disabled")}
                                </div>
                                ${pkg.reason && html`<div class="warn small">${pkg.reason}</div>`}
                                <div class="settings-actions">
                                    <button
                                        class="button small"
                                        disabled=${busy !== null}
                                        onClick=${() => {
                                            if (trust("Update", pkg.name)) {
                                                void change(
                                                    {
                                                        action: "update",
                                                        name: pkg.name,
                                                        trusted: true,
                                                    },
                                                    "Update check complete. Any staged changes apply after server restart.",
                                                    "Checking and staging an update on the server…",
                                                );
                                            }
                                        }}
                                    >Update</button>
                                    <button
                                        class="button small ghost"
                                        disabled=${busy !== null || !pkg.previousVersion}
                                        onClick=${() => {
                                            if (trust("Roll back", pkg.name)) {
                                                void change(
                                                    {
                                                        action: "rollback",
                                                        name: pkg.name,
                                                        trusted: true,
                                                    },
                                                    "Previous release selected. Restart the server to apply it.",
                                                );
                                            }
                                        }}
                                    >Roll back${pkg.previousVersion ? ` to ${pkg.previousVersion}` : ""}</button>
                                </div>
                                ${pkg.compatible && pkg.settings !== undefined && html`<${PackageConfiguration} pkg=${pkg} busy=${busy !== null} change=${change} />`}
                            </div>
                            ${
                                pkg.compatible &&
                                html`<div class="extension-actions">
                                <${Switch}
                                    on=${pkg.enabled}
                                    disabled=${busy !== null}
                                    label=${`${pkg.name}: ${pkg.enabled ? "on" : "off"}`}
                                    onChange=${() => togglePackage(pkg)}
                                />
                            </div>`
                            }
                        </div>`,
                        )}
                    </div>`
                }
                ${
                    data &&
                    html`<div class="group">
                        <div class="group-title">Discovered packages</div>
                        ${available.length === 0 && html`<p class="muted small">No other provider packages found on the server.</p>`}
                        ${available.map(
                            (pkg) => html`<div class="extension" key=${pkg.id}>
                            <div class="extension-main">
                                <div class="extension-title">${pkg.name}</div>
                                <div class="muted small mono">${pkg.version}</div>
                                ${pkg.reason && html`<div class="warn small">${pkg.reason}</div>`}
                                ${
                                    pkg.compatible &&
                                    html`<div class="settings-actions">
                                    <button
                                        class="button small"
                                        disabled=${busy !== null}
                                        onClick=${() => {
                                            if (trust("Select", pkg.name)) {
                                                void change(
                                                    { action: "select", id: pkg.id, trusted: true },
                                                    "Package staged. Restart the server to apply it.",
                                                    "Staging discovered package on the server…",
                                                );
                                            }
                                        }}
                                    >Select package</button>
                                </div>`
                                }
                            </div>
                        </div>`,
                        )}
                        <button class="button small ghost" disabled=${busy !== null} onClick=${load}>
                            Refresh discovered packages
                        </button>
                    </div>`
                }
                ${
                    data &&
                    html`<details class="group">
                        <summary>Add package</summary>
                        <form onSubmit=${install}>
                            <p class="muted small">Install an exact npm release on the server. Installation does not prove compatibility or trust.</p>
                            <label class="field">
                                <span class="label">Exact npm source</span>
                                <input
                                    value=${source}
                                    required
                                    disabled=${busy !== null}
                                    autocomplete="off"
                                    spellcheck="false"
                                    placeholder="npm:package-name@1.2.3"
                                    onInput=${(event) => setSource(event.currentTarget.value)}
                                />
                            </label>
                            <button class="button small" type="submit" disabled=${busy !== null || !source.trim()}>
                                Install & stage
                            </button>
                        </form>
                    </details>`
                }
                ${(busy || data?.busy) && data && html`<p class="muted small" role="status">${busy || data.busy}</p>`}
                ${data?.error && html`<div class="error-box" role="alert">${data.error}</div>`}
                ${
                    problem &&
                    html`<div class="error-box" role="alert">
                    ${problem}
                    <button class="button small" disabled=${busy !== null} onClick=${load}>Retry</button>
                </div>`
                }
                ${message && html`<p class="ok small" role="status">${message}</p>`}
            </div>
        </details>
    </section>`;
}
