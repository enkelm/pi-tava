// Owner-only SSH password entry. Secrets never enter app state, drafts or destination metadata.
import { useEffect, useLayoutEffect, useRef, useState } from "preact/hooks";
import { api, store } from "./store.js";
import { html, Spinner } from "./ui.js";
import { observeSsh } from "./ssh-status.js";

export function SshLogin({ host, onAuthenticated, disabled = false }) {
    const [expanded, setExpanded] = useState(false);
    const { me, server } = store.state;

    if (
        me?.role !== "owner" ||
        !(server?.sshPasswords >= 1) ||
        typeof host !== "string" ||
        !host.trim()
    ) {
        return null;
    }

    return html`<details class="ssh-password-options" open=${expanded} onToggle=${(event) => setExpanded(event.currentTarget.open)}>
        <summary>Password login</summary>
        ${
            expanded &&
            html`<${SshLoginFields}
            key=${JSON.stringify([me.id, host])}
            host=${host}
            userId=${me.id}
            disabled=${disabled}
            onAuthenticated=${onAuthenticated}
        />`
        }
    </details>`;
}

function SshLoginFields({ host, userId, disabled, onAuthenticated }) {
    const secure = globalThis.isSecureContext === true;
    const [status, setStatus] = useState(null);
    const [pending, setPending] = useState(secure ? "status" : null);
    const [error, setError] = useState("");
    const [hasPassword, setHasPassword] = useState(false);
    const input = useRef(null);
    const alive = useRef(false);
    const flight = useRef(null);
    const latest = useRef(null);
    const refresh = useRef(null);
    const departed = useRef(false);

    latest.current = { disabled, onAuthenticated };

    const allowed = () =>
        alive.current &&
        !departed.current &&
        !document.hidden &&
        navigator.onLine !== false &&
        globalThis.isSecureContext === true &&
        store.state.me?.id === userId &&
        store.state.me?.role === "owner" &&
        store.state.server?.sshPasswords >= 1;

    const clearInput = () => {
        if (input.current) {
            input.current.value = "";
        }
    };

    const abort = () => {
        const previous = flight.current;

        flight.current = null;
        clearTimeout(refresh.current);
        refresh.current = null;
        clearTimeout(previous?.timeout);
        previous?.controller.abort();
    };

    const request = (operation) => {
        if (!allowed() || (operation !== "status" && latest.current.disabled)) {
            clearInput();
            setHasPassword(false);

            return;
        }

        if (flight.current) {
            return;
        }

        let password = operation === "login" ? (input.current?.value ?? "") : "";

        // Clear the visible field before calling fetch, including on validation failure.
        clearInput();
        setHasPassword(false);

        if (operation === "login" && !password) {
            return;
        }

        const controller = new AbortController();
        const current = { controller, timeout: setTimeout(() => controller.abort(), 30000) };
        const stillCurrent = () => allowed() && flight.current === current;

        flight.current = current;
        setPending(operation);
        setError("");

        const result =
            operation === "status"
                ? api(`ssh-auth?host=${encodeURIComponent(host)}`, undefined, {
                      signal: controller.signal,
                  })
                : operation === "forget"
                  ? api("ssh-auth", { host, forget: true }, { signal: controller.signal })
                  : observeSsh({ kind: "ssh", host }, () =>
                        api("ssh-auth", { host, password }, { signal: controller.signal }),
                    );

        password = "";
        result.then(
            (response) => {
                clearTimeout(current.timeout);

                if (!stillCurrent()) {
                    return;
                }

                flight.current = null;
                setPending(null);
                setStatus(response);

                if (operation === "login" && response.authenticated === true) {
                    // Only a newly accepted login can retry a caller's read, never commands or mutations.
                    latest.current.onAuthenticated?.();
                }
            },
            (failure) => {
                clearTimeout(current.timeout);

                if (!stillCurrent()) {
                    return;
                }

                flight.current = null;
                setPending(null);
                setStatus(null);
                const detail =
                    failure.name === "AbortError"
                        ? "SSH login timed out."
                        : (failure.message ?? "Could not reach Coop.");
                const next =
                    operation === "status"
                        ? "Check your Coop connection."
                        : "Check login status before retrying.";

                setError(`${detail} ${next}`);
            },
        );
    };

    useLayoutEffect(() => {
        alive.current = true;
        let active;

        const update = () => {
            const next = allowed();

            if (next === active) {
                return;
            }

            active = next;

            if (next) {
                request("status");
            } else {
                abort();
                clearInput();
                setHasPassword(false);
                setStatus(null);
                setPending(null);
                setError("");
            }
        };

        const hide = () => {
            departed.current = true;
            update();
        };

        const show = () => {
            departed.current = false;
            update();
        };

        const unsubscribe = store.subscribe(update);

        document.addEventListener("visibilitychange", update);
        addEventListener("online", update);
        addEventListener("offline", update);
        addEventListener("pagehide", hide);
        addEventListener("pageshow", show);
        update();

        return () => {
            alive.current = false;
            unsubscribe();
            document.removeEventListener("visibilitychange", update);
            removeEventListener("online", update);
            removeEventListener("offline", update);
            removeEventListener("pagehide", hide);
            removeEventListener("pageshow", show);
            abort();
            clearInput();
        };
    }, [host, userId, secure]);

    // Use server-relative lifetime: a phone clock ahead of Coop must not create a 1 Hz loop.
    // Hidden/offline/departed controls cancel this timer and get one fresh read on return.
    useEffect(() => {
        if (!allowed() || !status?.authenticated || !Number.isFinite(status.expiresInMs)) {
            return;
        }

        const timeout = setTimeout(() => request("status"), Math.max(1000, status.expiresInMs));

        refresh.current = timeout;

        return () => {
            clearTimeout(timeout);

            if (refresh.current === timeout) {
                refresh.current = null;
            }
        };
    }, [status]);

    if (
        store.state.me?.id !== userId ||
        store.state.me?.role !== "owner" ||
        !(store.state.server?.sshPasswords >= 1)
    ) {
        return null;
    }

    const busy = pending !== null;
    const blocked = !secure || disabled || busy;
    const authenticated = status?.authenticated === true;

    return html`<div class="workspace-location ssh-login" aria-busy=${busy}>
        ${
            authenticated
                ? html`<p class="muted small" role="status">SSH password login is active.</p>
                    <button
                        class="button"
                        type="button"
                        disabled=${blocked}
                        onClick=${() => request("forget")}
                    >
                        ${pending === "forget" ? "Forgetting login…" : "Forget login"}
                    </button>`
                : html`<label>
                    <span class="label">SSH password</span>
                    <input
                        ref=${input}
                        type="password"
                        aria-label="SSH password"
                        autocomplete="current-password"
                        autocapitalize="off"
                        spellcheck="false"
                        enterkeyhint="go"
                        disabled=${blocked}
                        onInput=${(event) => setHasPassword(event.currentTarget.value.length > 0)}
                        onKeyDown=${(event) => {
                            if (event.key === "Enter") {
                                event.preventDefault();
                                event.stopPropagation();

                                if (!event.isComposing && !event.repeat) {
                                    request("login");
                                }
                            }
                        }}
                    />
                </label>
                <button
                    class="button"
                    type="button"
                    disabled=${blocked || !hasPassword}
                    onClick=${() => request("login")}
                >
                    ${pending === "login" ? "Logging in…" : "Log in with password"}
                </button>`
        }
        ${pending === "status" && html`<p class="muted small" role="status"><${Spinner} hidden=${true} /> Checking SSH login…</p>`}
        <p class="muted small">${secure ? "Memory only · 30 min idle · 8 h max" : "Open Coop over HTTPS to enter a password."}</p>
        ${error && html`<p class="error small" role="alert">${error}</p>`}
        ${
            error &&
            html`<button
                class="button"
                type="button"
                disabled=${blocked}
                onClick=${() => request("status")}
            >
                Check login status
            </button>`
        }
    </div>`;
}
