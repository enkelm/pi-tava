// Owner-only retained Herdr connections. Opening Terminal is control intent; input is never queued or replayed.
import { useEffect, useLayoutEffect, useMemo, useRef, useState } from "preact/hooks";
import { api, store, uid } from "./store.js";
import { prefs, setPrefs } from "./theme.js";
import { html, Icon } from "./ui.js";

const owner = () => (store.state.me?.role === "owner" ? store.state.me.id : null);
const awake = () => document.visibilityState !== "hidden" && navigator.onLine !== false;
const empty = (phase = "idle", reason = "") => ({
    phase,
    reason,
    surface: null,
    images: [],
    snapshot: null,
    welcome: null,
    bootId: null,
    inputEpoch: null,
    clipboard: null,
    reportAllKeys: false,
    paused: !awake(),
});
const pool = new Map();
const targets = new Map();
const observers = new Set();
let selectedInstance = null;
let poolOwner = owner();
let active = null;
let inputSequence = 0;

function publish() {
    const entry = pool.get(selectedInstance);
    const next = entry?.state.snapshot
        ? {
              instanceId: entry.instanceId,
              snapshot: entry.state.snapshot,
              view: entry.listeners.size ? "terminal" : "chat",
              request: (method, params) => entry.request(method, params),
          }
        : null;

    if (
        active?.snapshot === next?.snapshot &&
        active?.instanceId === next?.instanceId &&
        active?.view === next?.view
    ) {
        return;
    }

    active = next;
    observers.forEach((listener) => listener(next));
}

export function useLiveTerminal() {
    const [live, setLive] = useState(active);

    useLayoutEffect(() => {
        observers.add(setLive);
        setLive(active);

        return () => observers.delete(setLive);
    }, []);

    return live;
}

export function selectTerminalInstance(instanceId) {
    selectedInstance = instanceId || null;
    publish();
}

/** Map only owner-authorized opaque targets. No socket paths, process IDs or guessed titles. */
export function syncTerminalTargets(data) {
    if (!data || owner() === null) {
        return;
    }

    targets.clear();

    for (const instance of data.instances || []) {
        const panes = new Map();

        for (const workspace of instance.workspaces) {
            for (const tab of workspace.tabs) {
                for (const pane of tab.panes) {
                    if (pane.nativeId) {
                        panes.set(pane.nativeId, pane.id);
                    }
                }
            }
        }

        targets.set(instance.id, panes);
        const entry = pool.get(instance.id);

        if (entry?.nativeId && panes.has(entry.nativeId)) {
            entry.id = panes.get(entry.nativeId);
            entry.connection.setTarget(entry.id);
            entry.retry();
        }
    }
}

/** Transport only. Hidden pages retain the latest bounded frame but never paint or send input. */
export function terminalConnection(id, changed, lifecycle = {}) {
    const who = owner();
    let target = id;
    let state = empty();
    let socket = null;
    let request = null;
    let generation = 0;
    let disposed = false;
    let deadline;
    const authorized = () => !disposed && who !== null && who === owner();

    const emit = (next, force = false) => {
        state = next;

        if (awake() || force) {
            changed({
                ...state,
                paused: !awake(),
                surface: awake() ? state.surface : null,
                images: awake() ? state.images : [],
            });
        }
    };

    const drop = (reason, retryable = false) => {
        generation++;
        clearTimeout(deadline);
        request?.abort();
        request = null;
        const previous = socket;

        socket = null;
        previous?.close();
        emit(empty("closed", reason), true);

        if (!disposed) {
            lifecycle.closed?.(reason, retryable);
        }
    };

    const visibility = () => {
        emit(state, true);

        if (awake()) {
            lifecycle.available?.();
        }
    };

    const offline = () => drop("Offline. Reconnecting when online; input is never replayed.", true);
    const online = () => lifecycle.available?.();
    const pagehide = () => drop("Disconnected when leaving this page.");
    const unsubscribe = store.subscribe(() => {
        if (owner() !== who) {
            drop("Private access ended.");
        }
    });

    document.addEventListener("visibilitychange", visibility);
    window.addEventListener("offline", offline);
    window.addEventListener("online", online);
    window.addEventListener("pagehide", pagehide);

    return {
        setTarget(next) {
            target = next;
        },
        async connect(size) {
            if (!authorized() || !awake() || request || socket) {
                return;
            }

            const turn = ++generation;
            const controller = new AbortController();

            request = controller;
            emit({ ...empty("connecting"), inputEpoch: ++inputSequence }, true);
            deadline = setTimeout(() => drop("Herdr did not connect in time.", true), 15000);

            try {
                const result = await api(
                    `private/${encodeURIComponent(target)}/terminal`,
                    { ...size, acknowledged: true },
                    { signal: controller.signal },
                );

                if (turn !== generation || !authorized()) {
                    return;
                }

                const url = new URL(result.url, location.href);
                const protocol = location.protocol === "https:" ? "wss:" : "ws:";

                if (
                    ![protocol, location.protocol].includes(url.protocol) ||
                    url.host !== location.host
                ) {
                    throw new Error("Herdr returned an invalid terminal address.");
                }

                url.protocol = protocol;
                const ws = new WebSocket(url.href);

                socket = ws;

                ws.onmessage = (event) => {
                    if (socket !== ws || turn !== generation || !authorized()) {
                        return;
                    }

                    let frame;

                    try {
                        frame = JSON.parse(event.data);
                    } catch {
                        drop("Herdr sent an unreadable frame. Reconnect to start fresh.");

                        return;
                    }

                    if (frame.type === "connected") {
                        emit({ ...state, phase: "connected", reason: "", welcome: frame.welcome });
                    } else if (frame.type === "surface") {
                        if (
                            frame.surface?.boot_id !== state.bootId ||
                            String(frame.surface.projection_revision) !==
                                String(state.snapshot?.revision)
                        ) {
                            drop("Herdr sent a stale frame. Reconnect to start fresh.");

                            return;
                        }

                        emit({ ...state, surface: frame.surface });
                    } else if (frame.type === "images") {
                        emit({ ...state, images: frame.images });
                    } else if (frame.type === "snapshot") {
                        if (state.bootId && frame.snapshot.boot_id !== state.bootId) {
                            drop("Herdr restarted. Reconnecting with a fresh snapshot.", true);

                            return;
                        }

                        clearTimeout(deadline);
                        emit({
                            ...state,
                            snapshot: frame.snapshot,
                            bootId: frame.snapshot.boot_id,
                            surface:
                                String(state.surface?.projection_revision) ===
                                String(frame.snapshot.revision)
                                    ? state.surface
                                    : null,
                        });
                    } else if (frame.type === "message") {
                        const message = frame.message;

                        if (message?.Clipboard?.data?.length <= 1_400_000) {
                            try {
                                const bytes = Uint8Array.from(atob(message.Clipboard.data), (ch) =>
                                    ch.charCodeAt(0),
                                );
                                const clipboard = new TextDecoder("utf-8", { fatal: true }).decode(
                                    bytes,
                                );

                                emit({ ...state, clipboard });
                            } catch {
                                emit({
                                    ...state,
                                    reason: "Herdr offered clipboard data this browser cannot decode.",
                                });
                            }
                        } else if (message?.ClientShellKeyboardReportAll) {
                            emit({
                                ...state,
                                reportAllKeys: message.ClientShellKeyboardReportAll.enabled,
                            });
                        } else if (
                            message?.ClientShellError ||
                            message?.SemanticNotification ||
                            message?.Notify ||
                            message?.TerminalBell
                        ) {
                            emit({
                                ...state,
                                reason:
                                    message.ClientShellError?.message ||
                                    message.SemanticNotification?.title ||
                                    message.Notify?.message ||
                                    "Terminal bell",
                            });
                        }
                    } else if (frame.type === "closed") {
                        const authLost = frame.reason === "Owner access ended";

                        drop(frame.reason || "Herdr disconnected. Reconnecting…", !authLost);

                        if (authLost) {
                            store.set({ me: { ...store.state.me, role: "viewer" } });
                        }
                    } else if (frame.type === "rejected") {
                        lifecycle.response?.(frame.requestId, { error: { message: frame.reason } });
                        emit({
                            ...state,
                            reason:
                                frame.reason || "Herdr rejected the action. It was not retried.",
                        });
                    } else if (frame.type === "response") {
                        lifecycle.response?.(frame.requestId, frame.response);

                        if (frame.response?.error) {
                            emit({
                                ...state,
                                reason:
                                    frame.response.error.message ||
                                    "Herdr could not perform that action.",
                            });
                        }
                    }
                };

                ws.onerror = () => {
                    if (socket === ws) {
                        drop(
                            "Terminal connection failed. Reconnecting without replaying input.",
                            true,
                        );
                    }
                };

                ws.onclose = () => {
                    if (socket === ws) {
                        drop(
                            "Terminal connection closed. Reconnecting without replaying input.",
                            true,
                        );
                    }
                };
            } catch (error) {
                if (turn !== generation || !authorized()) {
                    return;
                }

                drop(error.message, !error.status || error.status >= 500 || error.status === 409);

                if (error.status === 401 || error.status === 403) {
                    store.set({
                        me: error.status === 401 ? null : { ...store.state.me, role: "viewer" },
                    });
                }
            } finally {
                if (turn === generation) {
                    request = null;
                }
            }
        },
        interest(active, requestId) {
            if (
                !authorized() ||
                !state.bootId ||
                state.phase !== "connected" ||
                socket?.readyState !== 1
            ) {
                return false;
            }

            try {
                socket.send(
                    JSON.stringify({
                        type: "request",
                        method: "client_shell.surface.set",
                        params: { active },
                        requestId,
                        bootId: state.bootId,
                    }),
                );

                return true;
            } catch {
                drop("Surface subscription failed. Reconnecting…", true);

                return false;
            }
        },
        clearSurface() {
            emit({ ...state, surface: null, images: [], clipboard: null }, true);
        },
        send(frame) {
            if (
                !authorized() ||
                !awake() ||
                !state.bootId ||
                state.phase !== "connected" ||
                socket?.readyState !== 1
            ) {
                return false;
            }

            try {
                socket.send(
                    JSON.stringify({
                        ...frame,
                        bootId: state.bootId,
                        ...(frame.type === "request" ? { requestId: "web-" + uid() } : {}),
                    }),
                );

                return true;
            } catch {
                drop("Terminal input was not retried. Reconnecting…", true);

                return false;
            }
        },
        close(reason = "Disconnected. Reconnect when ready.") {
            drop(reason);
        },
        dispose() {
            disposed = true;
            drop("");
            unsubscribe();
            document.removeEventListener("visibilitychange", visibility);
            window.removeEventListener("offline", offline);
            window.removeEventListener("online", online);
            window.removeEventListener("pagehide", pagehide);
        },
    };
}

function acquire(instanceId, id, nativeId) {
    let entry = pool.get(instanceId);

    if (!entry) {
        if (pool.size >= 4) {
            const oldest = [...pool.values()].sort(
                (a, b) =>
                    Number(Boolean(a.listeners.size)) - Number(Boolean(b.listeners.size)) ||
                    a.used - b.used,
            )[0];

            oldest.dispose();
            pool.delete(oldest.instanceId);
        }

        entry = {
            instanceId,
            id,
            nativeId,
            pendingFocus: nativeId,
            requestedFocus: null,
            state: empty(),
            raw: empty(),
            interestAck: null,
            interestPending: null,
            listeners: new Set(),
            desired: false,
            attempts: 0,
            timer: null,
            size: null,
            used: Date.now(),
        };

        entry.surfaceInterest = () => {
            if (
                entry.state.phase !== "connected" ||
                !entry.state.snapshot ||
                entry.interestPending
            ) {
                return;
            }

            const interested = entry.listeners.size > 0 && awake();

            if (entry.interestAck === interested) {
                return;
            }

            if (!entry.state.welcome?.methods?.includes("client_shell.surface.set")) {
                entry.interestAck = true;

                return;
            }

            const requestId = "surface-" + uid();
            const timeout = setTimeout(() => {
                if (entry.interestPending?.id === requestId) {
                    entry.interestPending = null;
                    entry.connection.close(
                        "Herdr did not acknowledge surface activity. Reconnect to start fresh.",
                    );
                }
            }, 5000);

            entry.interestPending = { id: requestId, active: interested, timeout };

            if (interested) {
                entry.connection.clearSurface();
            }

            if (!entry.connection.interest(interested, requestId)) {
                clearTimeout(timeout);
                entry.interestPending = null;
            }
        };

        entry.notify = (state) => {
            entry.raw = state;
            entry.state = {
                ...state,
                targetPending: Boolean(entry.pendingFocus),
                surfaceActive:
                    entry.interestAck === true &&
                    !entry.interestPending &&
                    entry.listeners.size > 0 &&
                    awake(),
                surfacePending: Boolean(entry.interestPending),
            };

            if (state.phase === "connected" && state.snapshot) {
                entry.attempts = 0;
                const focused = state.snapshot.focused_pane_id;

                if (entry.pendingFocus === focused) {
                    entry.pendingFocus = null;
                    entry.requestedFocus = null;
                }

                if (!entry.pendingFocus && focused) {
                    entry.nativeId = focused;
                    const opaque = targets.get(instanceId)?.get(focused);

                    if (opaque) {
                        entry.id = opaque;
                        entry.connection.setTarget(opaque);
                    }
                }

                if (
                    entry.pendingFocus &&
                    entry.requestedFocus !== entry.pendingFocus &&
                    state.snapshot.panes.some((pane) => pane.pane_id === entry.pendingFocus)
                ) {
                    if (entry.request("pane.focus", { pane_id: entry.pendingFocus })) {
                        entry.requestedFocus = entry.pendingFocus;
                    }
                }
            }

            entry.surfaceInterest();
            entry.state = {
                ...entry.raw,
                targetPending: Boolean(entry.pendingFocus),
                surfaceActive:
                    entry.interestAck === true &&
                    !entry.interestPending &&
                    entry.listeners.size > 0 &&
                    awake(),
                surfacePending: Boolean(entry.interestPending),
            };
            entry.listeners.forEach((listener) => listener(entry.state));
            publish();
        };

        entry.retry = () => {
            if (
                !entry.desired ||
                !entry.size ||
                !awake() ||
                entry.timer ||
                entry.state.phase === "connecting" ||
                entry.state.phase === "connected"
            ) {
                return;
            }

            if (entry.nativeId && !targets.get(instanceId)?.has(entry.nativeId)) {
                entry.notify({
                    ...entry.state,
                    reason: "The current pane is unavailable. Waiting for an updated Private list.",
                });

                return;
            }

            if (entry.attempts >= 6) {
                entry.desired = false;
                entry.notify({
                    ...entry.state,
                    reason: "Reconnection paused after six attempts. Reconnect to try again.",
                });

                return;
            }

            const delay =
                entry.attempts === 0 ? 0 : Math.min(10000, 500 * 2 ** (entry.attempts - 1));

            entry.timer = setTimeout(() => {
                entry.timer = null;

                if (!entry.desired || !awake()) {
                    return;
                }

                entry.attempts++;
                entry.requestedFocus = null;
                entry.pendingFocus = entry.nativeId;
                entry.connection.connect(entry.size);
            }, delay);
        };

        entry.connection = terminalConnection(id, entry.notify, {
            response: (requestId, response) => {
                if (entry.interestPending?.id !== requestId) {
                    return;
                }

                const pending = entry.interestPending;

                clearTimeout(pending.timeout);
                entry.interestPending = null;

                if (response?.error) {
                    entry.connection.close(
                        "Herdr could not change surface activity: " +
                            (response.error.message || "request rejected"),
                    );

                    return;
                }

                entry.interestAck = pending.active;

                if (!pending.active) {
                    entry.connection.clearSurface();
                }

                entry.notify(entry.raw);
            },
            closed: (_reason, retryable) => {
                clearTimeout(entry.interestPending?.timeout);
                entry.interestPending = null;
                entry.interestAck = null;

                if (!retryable) {
                    entry.desired = false;
                }

                entry.retry();
            },
            available: entry.retry,
        });

        entry.request = (method, params, confirmed) => {
            if (method === "pane.focus") {
                const snapshot = entry.state.snapshot;
                const pane = snapshot?.panes.find((item) => item.pane_id === params.pane_id);
                const steps = pane
                    ? [
                          [
                              "workspace.focus",
                              "workspace_id",
                              pane.workspace_id,
                              snapshot.focused_workspace_id,
                          ],
                          ["tab.focus", "tab_id", pane.tab_id, snapshot.focused_tab_id],
                      ]
                    : [];

                for (const [focusMethod, key, next, current] of steps) {
                    if (
                        next &&
                        next !== current &&
                        (!entry.state.welcome?.methods?.includes(focusMethod) ||
                            !entry.connection.send({
                                type: "request",
                                method: focusMethod,
                                params: { [key]: next },
                            }))
                    ) {
                        return false;
                    }
                }
            }

            return entry.connection.send({
                type: "request",
                method,
                params,
                ...(confirmed ? { confirmed: true } : {}),
            });
        };

        entry.open = (size) => {
            entry.used = Date.now();
            entry.size = size;
            entry.desired = true;
            entry.attempts = 0;
            entry.retry();
        };

        entry.disconnect = () => {
            entry.desired = false;
            clearTimeout(entry.timer);
            entry.timer = null;
            entry.connection.close();
        };

        entry.dispose = () => {
            entry.desired = false;
            clearTimeout(entry.timer);
            entry.timer = null;
            clearTimeout(entry.interestPending?.timeout);
            entry.interestPending = null;
            entry.connection.dispose();
            entry.listeners.clear();
        };

        pool.set(instanceId, entry);
    }

    entry.used = Date.now();

    if (entry.id !== id) {
        entry.id = id;
        entry.nativeId = nativeId;
        entry.pendingFocus = nativeId;
        entry.requestedFocus = null;
        entry.connection.setTarget(id);
        entry.notify(entry.state);
    }

    selectedInstance = instanceId;
    publish();

    return entry;
}

export function disconnectPrivateTerminal(instanceId) {
    pool.get(instanceId)?.disconnect();
}

export function privateTerminalPoolSize() {
    return pool.size;
}

store.subscribe(() => {
    const next = owner();

    if (next !== poolOwner) {
        poolOwner = next;
        const previous = [...pool.values()];

        pool.clear();
        targets.clear();
        selectedInstance = null;
        previous.forEach((entry) => entry.dispose());
        publish();
    }
});

function terminalTheme(base) {
    const styles = getComputedStyle(document.documentElement);

    const color = (name, fallback) => {
        const hex = styles.getPropertyValue(name).trim();

        return /^#[\da-f]{6}$/i.test(hex) ? parseInt(hex.slice(1), 16) : fallback;
    };

    const palette = [...base.palette];
    const names = ["bg-dark", "red", "green", "yellow", "blue", "magenta", "cyan", "fg"];

    names.forEach((name, index) => {
        palette[index] = color(`--o-${name}`, palette[index]);
        palette[index + 8] = color(`--o-${name}`, palette[index + 8]);
    });

    return {
        ...base,
        foreground: color("--o-fg-bright", base.foreground),
        background: color("--o-bg-dark", base.background),
        cursor: color("--o-fg-bright", base.cursor),
        palette,
    };
}

// Adapted from pinned GPUI controls.rs and keymap/{daemon,custom}.rs (Apache-2.0).
// Cmd is the platform/Super modifier, NEVER Ctrl. Daemon keys win collisions;
// empty daemon bindings remove that daemon binding, not GPUI's separate defaults.
const DAEMON_KEYS = [
    ["help", "help", "prefix+?"],
    ["toggle_sidebar", "sidebar", "prefix+b"],
    ["new_workspace", "workspace-new", "prefix+shift+n"],
    ["rename_workspace", "workspace-rename", "prefix+shift+w"],
    ["close_workspace", "workspace-close", "prefix+shift+d"],
    ["previous_workspace", "workspace-previous", ""],
    ["next_workspace", "workspace-next", ""],
    ["previous_agent", "agent-previous", ""],
    ["next_agent", "agent-next", ""],
    ["focus_agent", "agent-$", ""],
    ["switch_workspace", "workspace-$", ""],
    ["new_tab", "tab-new", "prefix+c"],
    ["previous_tab", "tab-previous", "prefix+p"],
    ["next_tab", "tab-next", "prefix+n"],
    ["rename_tab", "tab-rename", "prefix+shift+t"],
    ["move_tab_previous", "tab-move-left", ""],
    ["move_tab_next", "tab-move-right", ""],
    ["switch_tab", "tab-$", "prefix+1..9"],
    ["close_tab", "tab-close", "prefix+shift+x"],
    ["rename_pane", "pane-rename", "prefix+shift+p"],
    ["clear_pane", "clear", ""],
    ...["left", "down", "up", "right"].flatMap((direction, index) => [
        [`focus_pane_${direction}`, `focus-${direction}`, `prefix+${"hjkl"[index]}`],
        [`swap_pane_${direction}`, `swap-${direction}`, `prefix+shift+${"hjkl"[index]}`],
        [`resize_pane_${direction}`, `resize-${direction}`, ""],
    ]),
    ["cycle_pane_next", "pane-next", "prefix+tab"],
    ["cycle_pane_previous", "pane-previous", "prefix+shift+tab"],
    ["split_vertical", "split-right", "prefix+v"],
    ["split_horizontal", "split-down", "prefix+minus"],
    ["close_pane", "pane-close", "prefix+x"],
    ["zoom", "zoom", "prefix+z"],
];
const GPUI_KEYS = [
    ["cmd+b", "sidebar"],
    ["cmd+/", "help"],
    ["cmd+shift+n", "workspace-new"],
    ["cmd+t", "tab-new"],
    ["cmd+d", "split-right"],
    ["cmd+shift+d", "split-down"],
    ["cmd+shift+]", "tab-next"],
    ["cmd+shift+[", "tab-previous"],
    ["cmd+alt+]", "pane-next"],
    ["cmd+alt+[", "pane-previous"],
    ...["left", "right", "up", "down"].map((direction) => [
        `cmd+alt+${direction}`,
        `focus-${direction}`,
    ]),
    ["cmd+shift+enter", "zoom"],
    ["cmd+k", "clear"],
    ["cmd+w", "pane-close"],
    ["cmd+shift+w", "tab-close"],
    ...Array.from({ length: 9 }, (_, index) => [`cmd+${index + 1}`, `tab-${index + 1}`]),
];

export function eventStroke(event) {
    let key = event.key.toLowerCase().replace(/^arrow/, "");
    let shift = Boolean(event.shiftKey);

    if (event.code === "BracketRight") {
        key = "]";
    } else if (event.code === "BracketLeft") {
        key = "[";
    } else if (key.length === 1 && !/[a-z0-9]/i.test(key)) {
        shift = false; // A printed symbol such as '?' already carries its shift.
    }

    return `${event.ctrlKey ? "C" : ""}${event.altKey ? "A" : ""}${event.metaKey ? "M" : ""}${shift ? "S" : ""}:${key}`;
}

function parseStroke(raw) {
    const event = { ctrlKey: false, altKey: false, metaKey: false, shiftKey: false, key: "" };
    const aliases = {
        space: " ",
        return: "enter",
        esc: "escape",
        bs: "backspace",
        minus: "-",
        comma: ",",
        period: ".",
        slash: "/",
        backslash: "\\",
        quote: "'",
        double_quote: '"',
        semicolon: ";",
        colon: ":",
        percent: "%",
        ampersand: "&",
        backtick: "`",
        plus: "+",
    };

    for (const part of raw.trim().split("+")) {
        const lower = part.trim().toLowerCase();

        if (["ctrl", "control"].includes(lower)) {
            event.ctrlKey = true;
        } else if (["alt", "option", "meta"].includes(lower)) {
            event.altKey = true;
        } else if (["cmd", "command", "super"].includes(lower)) {
            event.metaKey = true;
        } else if (lower === "shift") {
            event.shiftKey = true;
        } else if (
            !event.key &&
            lower !== "hyper" &&
            (part.trim().length === 1 ||
                aliases[lower] ||
                /^(enter|escape|tab|backspace|delete|insert|home|end|pageup|pagedown|left|right|up|down|f([1-9]|[12][0-9]|3[0-5]))$/.test(
                    lower,
                ))
        ) {
            event.key = aliases[lower] || lower;
            event.shiftKey ||= /^[A-Z]$/.test(part.trim());
        } else {
            return null;
        }
    }

    if (!event.key) {
        return null;
    }

    // GPUI's shifted bracket bindings use the unshifted key plus the modifier.
    const stroke = `${event.ctrlKey ? "C" : ""}${event.altKey ? "A" : ""}${event.metaKey ? "M" : ""}${event.shiftKey ? "S" : ""}:${event.key}`;

    return { ...event, stroke };
}

/** A bounded reader for the normalized server profile's strings/string arrays, not arbitrary TOML. */
export function readKeyProfile(profile) {
    const keys = new Map();
    const indexed = new Map();
    let unsupported = false;
    let section = "";

    if (!profile) {
        return { keys, indexed, unsupported };
    }

    if (typeof profile !== "string" || profile.length > 65536) {
        return { keys, indexed, unsupported: true };
    }

    const lines = profile.split("\n");

    for (let i = 0; i < lines.length; i++) {
        const strip = (line) => {
            let quote = "";
            let escaped = false;

            for (let at = 0; at < line.length; at++) {
                const ch = line[at];

                if (escaped) {
                    escaped = false;
                } else if (quote === '"' && ch === "\\") {
                    escaped = true;
                } else if (quote && ch === quote) {
                    quote = "";
                } else if (!quote && (ch === '"' || ch === "'")) {
                    quote = ch;
                } else if (!quote && ch === "#") {
                    return line.slice(0, at).trim();
                }
            }

            return line.trim();
        };

        let line = strip(lines[i]);

        if (!line) {
            continue;
        }

        if (line.startsWith("[")) {
            section = line;
            continue;
        }

        if (section !== "[keys]" && section !== "[keys.indexed]") {
            continue;
        }

        const match = /^([\w-]+)\s*=\s*(.*)$/.exec(line);

        if (!match) {
            unsupported = true;
            continue;
        }

        let raw = match[2];

        while (raw.startsWith("[") && !raw.endsWith("]") && i + 1 < lines.length) {
            raw += strip(lines[++i]);
        }

        const values = [];
        const pattern = /"(?:[^"\\]|\\.)*"|'[^']*'/g;
        let token;
        let rest = raw;

        while ((token = pattern.exec(raw))) {
            try {
                values.push(token[0][0] === '"' ? JSON.parse(token[0]) : token[0].slice(1, -1));
                rest = rest.replace(token[0], "");
            } catch {
                unsupported = true;
            }
        }

        if (/^[\s,\[\]]*$/.test(rest) && (raw.startsWith("[") || values.length === 1)) {
            (section === "[keys]" ? keys : indexed).set(match[1], values.slice(0, 16));
        } else {
            unsupported = true;
        }
    }

    return { keys, indexed, unsupported };
}

export function terminalKeymap(snapshot) {
    const profile = readKeyProfile(snapshot?.server_keybindings_toml);
    const direct = new Map();
    const chords = new Map();
    const prefixes = new Set();
    const paneKeys = new Map();
    let unsupported = profile.unsupported;

    for (const [from, to] of [
        ["cmd+left", { key: "a", ctrlKey: true }],
        ["cmd+right", { key: "e", ctrlKey: true }],
        ["cmd+backspace", { key: "u", ctrlKey: true }],
        ["alt+left", { key: "b", altKey: true }],
        ["alt+right", { key: "f", altKey: true }],
    ]) {
        paneKeys.set(parseStroke(from).stroke, to);
    }

    for (const label of [
        ...(profile.keys.get("prefix") || []),
        ...(profile.keys.get("extra_prefixes") || []),
    ].slice(0, 16)) {
        const parsed = parseStroke(label);

        if (parsed && /[CAM]/.test(parsed.stroke.split(":")[0]) && !paneKeys.has(parsed.stroke)) {
            prefixes.add(parsed.stroke);
        } else {
            unsupported = true;
        }
    }

    if (!prefixes.size) {
        prefixes.add(parseStroke("ctrl+b").stroke);
    }

    const add = (label, command) => {
        const prefixed = label.startsWith("prefix+");
        const body = prefixed ? label.slice(7) : label;
        const expanded = body.includes("1..9")
            ? Array.from({ length: 9 }, (_, index) => body.replace("1..9", String(index + 1)))
            : [body];

        for (const entry of expanded) {
            const parsed = parseStroke(entry);

            if (!parsed) {
                unsupported ||= Boolean(entry);
                continue;
            }

            if (
                prefixes.has(parsed.stroke) ||
                (!prefixed &&
                    (paneKeys.has(parsed.stroke) || !/[CAM]/.test(parsed.stroke.split(":")[0])))
            ) {
                continue;
            }

            const target = prefixed ? chords : direct;
            const name = command.includes("$")
                ? /^[1-9]$/.test(parsed.key)
                    ? command.replace("$", parsed.key)
                    : null
                : command;

            if (name && !target.has(parsed.stroke)) {
                target.set(parsed.stroke, name);
            }
        }
    };

    const bindings = DAEMON_KEYS.map(([field, name, fallback]) => {
        const aliases =
            profile.keys.get(field) ||
            (field === "zoom" ? profile.keys.get("fullscreen") : undefined);
        const legacy = profile.indexed.get(
            { "tab-$": "tabs", "workspace-$": "workspaces", "agent-$": "agents" }[name],
        );

        return {
            name,
            configured: aliases !== undefined || legacy !== undefined,
            labels: [
                ...(aliases || (legacy ? [] : [fallback])),
                ...(legacy || [])
                    .filter((value) => value && !value.startsWith("prefix"))
                    .map((value) => `${value}+1..9`),
            ],
        };
    });

    for (const configured of [true, false]) {
        for (const binding of bindings.filter((item) => item.configured === configured)) {
            binding.labels.forEach((label) => add(label, binding.name));
        }
    }

    GPUI_KEYS.forEach(([label, name]) => add(label, name));
    (snapshot?.commands || []).forEach((command) =>
        (command.binding_labels || [])
            .slice(0, 8)
            .forEach((label) => add(label, `command:${command.command_id}`)),
    );

    return { direct, chords, prefixes, paneKeys, unsupported };
}

export function nativeCommand(name, snapshot) {
    if (!snapshot) {
        return null;
    }

    const workspace = snapshot.workspaces.find(
        (item) => item.workspace_id === snapshot.focused_workspace_id,
    );
    const tab = snapshot.tabs.find(
        (item) =>
            item.tab_id === snapshot.focused_tab_id &&
            item.workspace_id === workspace?.workspace_id,
    );
    const pane = snapshot.panes.find(
        (item) => item.pane_id === snapshot.focused_pane_id && item.tab_id === tab?.tab_id,
    );
    const paneId = pane?.pane_id;
    const tabs = snapshot.tabs.filter((item) => item.workspace_id === workspace?.workspace_id);
    const panes = snapshot.panes.filter((item) => item.tab_id === tab?.tab_id);
    const result = (method, params, label) => ({ method, params, label });
    const move = (items, id, key, direction) =>
        items[
            (items.findIndex((item) => item[key] === id) +
                (direction === "next" ? 1 : -1) +
                items.length) %
                items.length
        ]?.[key];

    if (
        name.startsWith("command:") &&
        snapshot.commands?.some((command) => command.command_id === name.slice(8))
    ) {
        return result("command.invoke", { command_id: name.slice(8) });
    }

    if (name === "workspace-new") {
        return result("workspace.create", {
            focus: true,
            ...(workspace ? { source_workspace_id: workspace.workspace_id } : {}),
        });
    }

    if (name === "tab-new" && workspace) {
        return result("tab.create", { workspace_id: workspace.workspace_id, focus: true });
    }

    if (name.startsWith("split-") && paneId) {
        return result("pane.split", {
            target_pane_id: paneId,
            direction: name.slice(6),
            focus: true,
        });
    }

    if ((name === "zoom" || name === "clear") && paneId) {
        return result(`pane.${name}`, {
            pane_id: paneId,
            ...(name === "zoom" ? { mode: "toggle" } : {}),
        });
    }

    const direction = /^(focus|resize|swap)-(left|right|up|down)$/.exec(name);

    if (direction && paneId) {
        return result(`pane.${direction[1] === "focus" ? "focus_direction" : direction[1]}`, {
            pane_id: paneId,
            direction: direction[2],
        });
    }

    const place = /^(workspace|agent)-(next|previous|[1-9])$/.exec(name);

    if (place) {
        const kind = place[1];
        const items = kind === "workspace" ? snapshot.workspaces : snapshot.agents || [];
        const key = kind === "workspace" ? "workspace_id" : "pane_id";
        const current = kind === "workspace" ? workspace?.workspace_id : paneId;
        const id = /^[1-9]$/.test(place[2])
            ? items[Number(place[2]) - 1]?.[key]
            : move(items, current, key, place[2]);

        return id
            ? result(`${kind === "workspace" ? "workspace" : "pane"}.focus`, { [key]: id })
            : null;
    }

    const cycle = /^(pane|tab)-(next|previous)$/.exec(name);

    if (cycle && paneId) {
        const kind = cycle[1];
        const id = move(
            kind === "pane" ? panes : tabs,
            kind === "pane" ? paneId : tab.tab_id,
            `${kind}_id`,
            cycle[2],
        );

        return id ? result(`${kind}.focus`, { [`${kind}_id`]: id }) : null;
    }

    const number = /^tab-([1-9])$/.exec(name);

    if (number && tabs[Number(number[1]) - 1]) {
        return result("tab.focus", { tab_id: tabs[Number(number[1]) - 1].tab_id });
    }

    if (name.startsWith("tab-move-") && tab && tabs.length > 1) {
        const at = tabs.findIndex((item) => item.tab_id === tab.tab_id);
        const insertIndex =
            name === "tab-move-right"
                ? at + 1 === tabs.length
                    ? 0
                    : at + 2
                : at === 0
                  ? tabs.length
                  : at - 1;

        return result("tab.move", { tab_id: tab.tab_id, insert_index: insertIndex });
    }

    const action = /^(pane|tab|workspace)-(rename|close)$/.exec(name);

    if (action) {
        const kind = action[1];
        const item = { pane, tab, workspace }[kind];

        return item
            ? result(`${kind}.${action[2]}`, { [`${kind}_id`]: item[`${kind}_id`] }, item.label)
            : null;
    }

    return null;
}

export function PrivateTerminal({
    id,
    instanceId,
    nativeId,
    statusError = "",
    fallback = "",
    available = true,
}) {
    const [state, setState] = useState(empty);
    const [Grid, setGrid] = useState(null);
    const [loadError, setLoadError] = useState("");
    const [theme, setTheme] = useState(null);
    const [notice, setNotice] = useState("");
    const controller = useRef(null);
    const retained = useRef(null);
    const opened = useRef(false);
    const lastSurface = useRef(null);
    const gridFocus = useRef(null);
    const wantsFocus = useRef(matchMedia("(min-width: 960px)").matches);
    const host = useRef(null);
    const prefix = useRef(null);
    const keyEncoder = useRef(null);
    const size = useRef({ cols: 80, rows: 24, cellWidth: 8, cellHeight: 20 });

    useLayoutEffect(() => {
        if (!instanceId) {
            return;
        }

        const entry = acquire(instanceId, id, nativeId);

        retained.current = entry;
        controller.current = entry.connection;
        entry.listeners.add(setState);
        entry.notify(entry.raw);

        return () => {
            entry.listeners.delete(setState);
            entry.surfaceInterest();
            publish();
            retained.current = null;
            controller.current = null;
        };
    }, [instanceId]);

    useLayoutEffect(() => {
        if (instanceId && retained.current) {
            acquire(instanceId, id, nativeId);
        }
    }, [id, instanceId, nativeId]);

    useLayoutEffect(() => {
        const focused = (event) => {
            const target = event.target;

            if (target.matches?.(".terminal-grid-input")) {
                wantsFocus.current = true;
            } else if (
                target.closest?.(
                    ".private-tabbar, .private-space-row, .private-pane-row, .private-connect",
                )
            ) {
                wantsFocus.current = true;
            } else if (target !== document.body && target !== document.documentElement) {
                wantsFocus.current = false;
            }
        };

        document.addEventListener("focusin", focused);

        return () => document.removeEventListener("focusin", focused);
    }, []);

    useLayoutEffect(() => {
        let mounted = true;
        let observer;

        import("./terminal-grid.js")
            .then((module) => {
                if (!mounted) {
                    return;
                }

                setGrid(() => module.TerminalGrid);
                keyEncoder.current = module.keyEvent;
                const updateTheme = () => setTheme(terminalTheme(module.DEFAULT_THEME));

                updateTheme();
                observer = new MutationObserver(updateTheme);
                observer.observe(document.documentElement, {
                    attributes: true,
                    attributeFilter: ["style", "data-mode"],
                });
            })
            .catch(() => {
                if (mounted) {
                    setLoadError("The terminal renderer could not load. Reload to try again.");
                }
            });

        return () => {
            mounted = false;
            observer?.disconnect();
        };
    }, []);

    const connected = state.phase === "connected" && Boolean(state.snapshot);
    const interactive =
        connected &&
        state.surfaceActive &&
        !state.paused &&
        Boolean(state.surface) &&
        !state.targetPending;

    if (!connected || state.paused || !state.surfaceActive) {
        lastSurface.current = null;
    } else if (state.surface) {
        lastSurface.current = state.surface;
    }

    // A metadata revision may arrive just before its matching surface. Keep the textarea node,
    // but never route input using the preceding frame. Resume focus only for terminal intent.
    const displaySurface = state.surface || lastSurface.current;

    useLayoutEffect(() => {
        if (
            !interactive ||
            !wantsFocus.current ||
            !matchMedia("(min-width: 960px)").matches ||
            !document.hasFocus() ||
            document.querySelector('dialog[open], [role="dialog"]')
        ) {
            return;
        }

        const input = host.current?.querySelector(".terminal-grid-input");
        const focused = document.activeElement;
        const otherField =
            focused?.matches('input, textarea, select, [contenteditable="true"]') &&
            focused !== input;

        if (input && focused !== input && !otherField) {
            gridFocus.current?.focus();
        }
    }, [
        interactive,
        state.surface,
        state.snapshot?.focused_pane_id,
        state.snapshot?.focused_tab_id,
        id,
    ]);
    const connecting =
        state.phase === "connecting" || (state.phase === "connected" && !state.snapshot);

    const request = (method, params, confirmed) =>
        retained.current?.request(method, params, confirmed);
    const paneId = state.snapshot?.focused_pane_id;

    const execute = (name) => {
        if (name === "sidebar") {
            if (matchMedia("(min-width: 960px)").matches) {
                setPrefs({ sidebar: prefs().sidebar === "rail" ? "open" : "rail" });
            } else {
                store.set({ drawer: !store.state.drawer });
            }

            return;
        }

        if (name === "help") {
            const help = host.current?.querySelector(".private-terminal-help");

            if (help) {
                help.open = !help.open;
            }

            return;
        }

        const command = nativeCommand(name, state.snapshot);

        if (!command || !state.welcome?.methods?.includes(command.method)) {
            setNotice("This action is not available from this Herdr connection.");

            return;
        }

        if (command.method.endsWith(".rename")) {
            const label = window.prompt("Rename in Herdr", command.label || "");

            if (label === null || !label.trim()) {
                return;
            }

            command.params.label = label.trim();
        }

        if (
            command.method.endsWith(".close") &&
            !window.confirm(
                `Close this Herdr ${command.method.split(".")[0]}? Running processes in it may stop. This cannot be undone.`,
            )
        ) {
            return;
        }

        setNotice("");
        request(command.method, command.params, command.method.endsWith(".close"));
    };

    const keymap = useMemo(() => terminalKeymap(state.snapshot), [state.snapshot]);

    const shortcut = (event) => {
        if (
            !interactive ||
            ["Shift", "Control", "Alt", "Meta", "AltGraph", "CapsLock"].includes(event.key) ||
            event.isComposing ||
            event.getModifierState?.("AltGraph") ||
            !event.target.matches?.(".terminal-grid-input") ||
            document.activeElement !== event.target
        ) {
            return;
        }

        const stroke = eventStroke(event);
        const isPrefix = keymap.prefixes.has(stroke);
        const armed = prefix.current;
        const name = (armed ? keymap.chords : keymap.direct).get(stroke);
        const translated = !armed && keymap.paneKeys.get(stroke);

        if (!armed && !isPrefix && !name && !translated) {
            return;
        }

        event.preventDefault();
        event.stopPropagation();

        if (
            event.repeat &&
            (isPrefix ||
                armed ||
                name?.endsWith("-close") ||
                name?.startsWith("split-") ||
                name?.endsWith("-new"))
        ) {
            return;
        }

        prefix.current = null;
        setNotice("");

        if (!armed && isPrefix) {
            prefix.current = stroke;
            setNotice("Herdr prefix: waiting for a key. Escape cancels.");
        } else if (armed && event.key === "Escape") {
            // Cancel prefix mode locally, never send an accidental Escape to a process.
        } else if ((armed && isPrefix) || translated) {
            const wire = keyEncoder.current?.(translated || event);

            if (wire && paneId) {
                controller.current?.send({ type: "input", paneId, events: [wire] });
            }
        } else if (name) {
            execute(name);
        } else {
            setNotice("This prefix chord is not supported in the browser. No input was sent.");
        }
    };

    useEffect(() => {
        if (theme && connected && state.bootId) {
            const rgb = (color) => ({
                r: (color >> 16) & 255,
                g: (color >> 8) & 255,
                b: color & 255,
            });

            controller.current?.send({
                type: "theme",
                theme: {
                    foreground: rgb(theme.foreground),
                    background: rgb(theme.background),
                    palette: theme.palette.map(rgb),
                    appearance:
                        document.documentElement.dataset.mode === "light" ? "Light" : "Dark",
                },
            });
        }
    }, [theme, connected, state.bootId]);

    const connect = () => {
        const viewport = host.current?.querySelector(".terminal-grid-viewport");
        const context = document.createElement("canvas").getContext("2d");

        context.font = '13px "Pocket Mono", monospace';
        const cellWidth = Math.max(1, Math.round(context.measureText("M").width));
        const cellHeight = 20;

        size.current = {
            cols: Math.max(
                1,
                Math.min(512, Math.floor((viewport?.clientWidth || 640) / cellWidth)),
            ),
            rows: Math.max(
                1,
                Math.min(256, Math.floor((viewport?.clientHeight || 480) / cellHeight)),
            ),
            cellWidth,
            cellHeight,
        };
        retained.current?.open(size.current);
    };

    useEffect(() => {
        if (!opened.current && available && Grid && instanceId && retained.current) {
            opened.current = true;
            connect();
        }
    }, [available, Grid, instanceId]);

    useEffect(() => {
        if (!interactive) {
            prefix.current = null;
            setNotice("");
        }
    }, [interactive]);

    return html`<div class="private-live-terminal" ref=${host} onKeyDownCapture=${shortcut}
        onCompositionEnd=${() =>
            queueMicrotask(() => {
                if (wantsFocus.current && awake() && matchMedia("(min-width: 960px)").matches) {
                    gridFocus.current?.focus();
                }
            })}
        onFocusIn=${() => controller.current?.send({ type: "focus", focused: true })}
        onFocusOut=${(event) => {
            if (prefix.current) {
                setNotice("");
                prefix.current = null;
            }

            if (!event.currentTarget.contains(event.relatedTarget)) {
                controller.current?.send({ type: "focus", focused: false });
            }
        }}>
        <div class="private-grid-host">
            ${
                Grid &&
                html`<${Grid}
                surface=${state.surfaceActive && !state.paused ? displaySurface : null}
                images=${interactive ? state.images : []}
                enabled=${interactive}
                inputEpoch=${state.inputEpoch}
                focusRef=${gridFocus}
                theme=${theme || undefined}
                reportAllKeys=${state.reportAllKeys}
                clipboardOffer=${state.clipboard}
                fontFamily='"Pocket Mono", monospace'
                fontSize=${13}
                onInput=${(targetId, events, popup) => controller.current?.send({ type: popup ? "popup-input" : "input", ...(popup ? { terminalId: targetId } : { paneId: targetId }), events })}
                onPasteImage=${(targetId, image, popup) => controller.current?.send({ type: "clipboard-image", target: popup ? { Popup: targetId } : { Pane: targetId }, ...image })}
                onResize=${(next) => {
                    size.current = {
                        cols: Math.min(512, next.cols),
                        rows: Math.min(256, next.rows),
                        cellWidth: next.cell_width_px,
                        cellHeight: next.cell_height_px,
                    };

                    if (retained.current) {
                        retained.current.size = size.current;
                    }

                    if (interactive) {
                        controller.current?.send({ type: "resize", ...size.current });
                    }
                }}
                onAction=${(action) => {
                    if (action.type === "focus-pane") {
                        return request("pane.focus", { pane_id: action.paneId });
                    }
                }}
            />`
            }
            ${(!interactive || !state.surface) && html`<pre class="private-terminal-preview" aria-label="Read-only terminal snapshot">${state.paused ? "Painting paused while hidden or offline." : fallback || "Waiting for terminal output…"}</pre>`}
        </div>
        ${
            connected &&
            html`<nav class="private-mobile-terminal-nav" aria-label="Herdr mobile controls">
            ${[
                ["tab-previous", "Prev tab"],
                ["tab-next", "Next tab"],
                ["tab-new", "New tab"],
                ["split-right", "Split"],
                ["zoom", "Zoom"],
            ].map(
                ([name, label]) => html`<button
                disabled=${!interactive || !state.welcome?.methods?.includes(nativeCommand(name, state.snapshot)?.method)}
                onClick=${() => execute(name)}
            >${label}</button>`,
            )}
        </nav>`
        }
        <div class="private-terminal-footer">
            <span class="small private-terminal-status" role="status" title=${statusError || notice || state.reason || loadError || "Opening Terminal allows control of this Herdr instance, including resizing or resuming a pending agent."}>${statusError || notice || state.reason || loadError || (state.paused ? "Painting paused" : connecting ? "Connecting…" : connected ? (state.surfacePending ? "Waiting for surface acknowledgement…" : "Live · Herdr") : "Disconnected")}</span>
            ${
                connected || connecting
                    ? html`<button class="private-disconnect" onClick=${() => retained.current?.disconnect()}>${connecting ? "Cancel" : "Disconnect"}</button>`
                    : html`<button class="private-connect" disabled=${!available || !Grid || !instanceId} onClick=${connect}>Reconnect</button>`
            }
        <details class="private-terminal-help">
            <summary class="icon-button" aria-label="Terminal help" title="Terminal help and browser limits"><${Icon} name="keyboard" size=${16} /></summary>
            <div class="private-help-tooltip" role="note">
            ${(statusError || notice || state.reason || loadError) && html`<p role="status">${statusError || notice || state.reason || loadError}</p>`}
            ${state.welcome && !state.welcome.methods?.includes("client_shell.surface.set") && html`<p>This Herdr connection does not advertise surface pausing. Only local painting can pause.</p>`}
            <p>Opening Terminal gives this browser control of the full Herdr instance. Connecting can resize panes or resume a pending agent. Access stays private to you.</p>
            <p>Click the terminal to type. Paste uses the terminal’s paste event. Escape, arrows and control keys go to Herdr while the terminal has focus.</p>
            <p>While the terminal has keyboard focus: Cmd+D splits right, Cmd+Shift+D splits down, Cmd+Shift+Enter zooms, Cmd+Option+arrows focus a pane, and Cmd+Shift+[ or ] change tabs. Cmd means Command on macOS and Super on Linux. Ctrl+C and Ctrl+D remain terminal input.</p>
            <p>Herdr’s default prefix is Ctrl+B, then c for a new tab, v to split right, minus to split down, z to zoom, n/p to switch tabs, and x to close a pane with confirmation. Repeat the prefix to send it to the terminal; Escape cancels. Published Herdr [keys] bindings and advertised command bindings replace the corresponding daemon defaults where supported.</p>
            <p>Browsers may reserve Cmd+T, Cmd+W, Cmd+1–9 and Cmd+L. We handle them only when delivered, without inventing replacement shortcuts. GPUI-local keybinding files, native windows, worktree management and native search dialogs are not mirrored. Clipboard writes and links always need your action.</p>
            ${keymap.unsupported && html`<p>Some published bindings use unsupported TOML or key syntax. Supported bindings and defaults remain available; unsupported bindings are not forwarded as commands.</p>`}
            <p>Chat and hidden pages keep the connection. Surface streaming pauses after Herdr acknowledges the request; local painting and input pause immediately. Offline connections retry with fresh snapshots and bounded backoff. Input is never queued or replayed. Disconnect stops automatic reconnection until Reconnect or reopening Terminal.</p>
            </div>
        </details>
        </div>
    </div>`;
}
