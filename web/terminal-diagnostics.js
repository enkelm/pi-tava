// Temporary owner-only, memory-only terminal telemetry. Retain only projected metadata;
// exported identifiers are aliases, never native IDs, titles, paths or credentials.
const MAX_EVENTS = 100;
const MAX_PANES = 16;
const MAX_REPORT_BYTES = 32 * 1024;
const encoder = new TextEncoder();
const focusKinds = new Map([
    ["pane.focus", "pane"],
    ["tab.focus", "tab"],
    ["workspace.focus", "workspace"],
]);
const scrollKinds = new Map([
    ["ScrollUp", "scrollUp"],
    ["ScrollDown", "scrollDown"],
    ["ScrollLeft", "scrollLeft"],
    ["ScrollRight", "scrollRight"],
]);
const object = (value) =>
    value && typeof value === "object" && !Array.isArray(value) ? value : {};
const number = (value, max = 1_000_000) =>
    typeof value === "number" && Number.isFinite(value) && Math.abs(value) <= max ? value : null;

const integer = (value) => {
    if (typeof value === "number" && Number.isSafeInteger(value) && value >= 0) {
        return value;
    }

    return typeof value === "string" && /^(0|[1-9]\d{0,19})$/.test(value) ? value : null;
};

const flag = (value) => (typeof value === "boolean" ? value : null);

const rect = (value) => {
    const r = object(value);

    return [number(r.x), number(r.y), number(r.width), number(r.height)];
};

export function terminalDiagnostics() {
    let start = Date.now();
    let events = [];
    let dropped = 0;
    let errors = 0;
    let latest = {};
    let counts = {};
    let stateKey = "";
    let snapshotKey = "";
    let viewKey = "";
    const aliases = new Map();
    const aliasCounts = {};
    const time = () => Math.max(0, Date.now() - start);
    const count = (kind) => (counts[kind] = (counts[kind] || 0) + 1);

    const alias = (kind, id) => {
        if (typeof id !== "string" || !id || id.length > 100) {
            return null;
        }

        const key = `${kind}:${id}`;

        if (!aliases.has(key)) {
            if (aliases.size >= 128) {
                return `${kind}-other`;
            }

            aliasCounts[kind] = (aliasCounts[kind] || 0) + 1;
            aliases.set(key, `${kind}-${aliasCounts[kind]}`);
        }

        return aliases.get(key);
    };

    const append = (kind, data, signature = JSON.stringify(data)) => {
        const last = events.at(-1);
        const at = time();

        if (last?.kind === kind && last.signature === signature) {
            last.lastMs = at;
            last.count++;
            last.data = data;

            return;
        }

        events.push({ atMs: at, lastMs: at, count: 1, kind, data, signature });

        if (events.length > MAX_EVENTS) {
            events.shift();
            dropped++;
        }
    };

    const safe =
        (callback, fallback = undefined) =>
        (...args) => {
            try {
                return callback(...args);
            } catch {
                // Instrumentation must never close a connection or change input delivery.
                errors++;

                return fallback;
            }
        };

    const geometry = (frame) => ({
        cols: number(frame.cols, 4096),
        rows: number(frame.rows, 4096),
        cellWidth: number(frame.cellWidth, 4096),
        cellHeight: number(frame.cellHeight, 4096),
    });

    return {
        sent: safe((value) => {
            const frame = object(value);

            if (frame.type === "resize" || frame.type === "connect") {
                const kind = frame.type === "resize" ? "resize" : "connect-request";

                count(kind);
                append(kind, geometry(frame));
            } else if (frame.type === "focus") {
                count("focus");
                append("focus", { focused: flag(frame.focused) });
            } else if (frame.type === "request") {
                count("request");
                const params = object(frame.params);
                const focusKind = focusKinds.get(frame.method);

                if (frame.method === "client_shell.surface.set") {
                    append("surface-interest", { active: flag(params.active) });
                } else if (focusKind) {
                    append("focus-target", {
                        kind: focusKind,
                        target: alias(focusKind, params[`${focusKind}_id`]),
                    });
                } else if (frame.method === "pane.scroll") {
                    append("scroll-request", {
                        pane: alias("pane", params.pane_id),
                        offset: integer(params.offset_from_bottom),
                    });
                } else {
                    append("request", { kind: "other" });
                }
            } else if (frame.type === "input" || frame.type === "popup-input") {
                count("input");
                const summary = {
                    keys: 0,
                    textCommits: 0,
                    pastes: 0,
                    mouse: 0,
                    scrollUp: 0,
                    scrollDown: 0,
                    scrollLeft: 0,
                    scrollRight: 0,
                };

                for (const event of (Array.isArray(frame.events) ? frame.events : []).slice(
                    0,
                    256,
                )) {
                    const e = object(event);

                    summary.keys += "Key" in e ? 1 : 0;
                    summary.textCommits += "TextCommit" in e ? 1 : 0;
                    summary.pastes += "Paste" in e ? 1 : 0;

                    if ("Mouse" in e) {
                        summary.mouse++;
                        const mouse = object(e.Mouse);
                        const kind = scrollKinds.get(mouse.kind);

                        if (kind) {
                            summary[kind] += Math.max(0, number(mouse.lines, 128) || 0);
                        }
                    }
                }

                append("input-counts", {
                    target: alias(
                        frame.type === "popup-input" ? "popup" : "pane",
                        frame.paneId || frame.terminalId,
                    ),
                    ...summary,
                });
            } else if (frame.type === "clipboard-image") {
                count("image-input");
                append("image-input", {});
            }
        }),
        received: safe((value) => {
            const frame = object(value);

            if (frame.type === "surface") {
                count("surfaces");
                const surface = object(frame.surface);
                const canvas = object(surface.frame);
                const cursor = object(canvas.cursor);
                const panes = (Array.isArray(surface.panes) ? surface.panes : [])
                    .slice(0, MAX_PANES)
                    .map((value) => {
                        const pane = object(value);
                        const scroll = object(pane.scroll);

                        return {
                            pane: alias("pane", pane.pane_id),
                            rect: rect(pane.inner_rect),
                            pixelWidth: number(pane.pixel_width),
                            pixelHeight: number(pane.pixel_height),
                            offset: integer(scroll.offset_from_bottom),
                            maxOffset: integer(scroll.max_offset_from_bottom),
                            viewportRows: integer(scroll.viewport_rows),
                            alternate: flag(pane.alternate_screen_active),
                            mouseReporting: flag(pane.mouse_reporting),
                            focused: flag(pane.focused),
                            contentRevision: integer(pane.content_revision),
                        };
                    });
                const data = {
                    boot: alias("boot", surface.boot_id),
                    projection: integer(surface.projection_revision),
                    revision: integer(surface.surface_revision),
                    cols: number(canvas.width, 4096),
                    rows: number(canvas.height, 4096),
                    cursor: [number(cursor.x, 4096), number(cursor.y, 4096), flag(cursor.visible)],
                    popup: alias("popup", object(surface.popup).terminal_id),
                    panes,
                };
                const signature = JSON.stringify([
                    data.boot,
                    data.cols,
                    data.rows,
                    data.cursor,
                    data.popup,
                    panes.map((p) => [
                        p.pane,
                        p.rect,
                        p.pixelWidth,
                        p.pixelHeight,
                        p.offset,
                        p.maxOffset,
                        p.viewportRows,
                        p.alternate,
                        p.mouseReporting,
                        p.focused,
                    ]),
                ]);

                latest.surface = data;
                append("surface", data, signature);
            } else if (frame.type === "snapshot") {
                count("snapshots");
                const snapshot = object(frame.snapshot);
                const data = {
                    boot: alias("boot", snapshot.boot_id),
                    revision: integer(snapshot.revision),
                    pane: alias("pane", snapshot.focused_pane_id),
                    tab: alias("tab", snapshot.focused_tab_id),
                    workspace: alias("workspace", snapshot.focused_workspace_id),
                };
                const key = JSON.stringify([data.boot, data.pane, data.tab, data.workspace]);

                latest.snapshot = data;

                if (key !== snapshotKey) {
                    snapshotKey = key;
                    append("snapshot-focus", data);
                }
            } else if (["connected", "closed", "rejected", "response"].includes(frame.type)) {
                const kind = frame.type;

                count(kind);

                if (kind !== "response" || object(frame.response).error) {
                    append(`received-${kind}`, { error: !!object(frame.response).error });
                }
            }
        }),
        state: safe((value) => {
            const state = object(value);
            const data = {
                phase: ["idle", "connecting", "connected", "closed"].includes(state.phase)
                    ? state.phase
                    : "other",
                epoch: integer(state.inputEpoch),
                boot: alias("boot", state.bootId),
                paused: flag(state.paused),
                hasSurface: !!state.surface,
                hasNotice: !!state.reason,
            };
            const key = JSON.stringify(data);

            latest.state = data;

            if (key !== stateKey) {
                stateKey = key;
                append("state", data);
            }
        }),
        view: safe((value) => {
            const view = object(value);
            const data = {
                width: number(view.width),
                height: number(view.height),
                cols: number(view.cols, 4096),
                rows: number(view.rows, 4096),
                scrollTop: number(view.scrollTop),
                scrollLeft: number(view.scrollLeft),
                canvasWidth: number(view.canvasWidth),
                canvasHeight: number(view.canvasHeight),
                coarsePointer: flag(view.coarsePointer),
                documentFocused: flag(view.documentFocused),
                surfaceActive: flag(view.surfaceActive),
                targetPending: flag(view.targetPending),
                inputEnabled: flag(view.inputEnabled),
                focus: [
                    "terminal-input",
                    "help",
                    "touch-keyboard",
                    "terminal-controls",
                    "outside",
                ].includes(view.focus)
                    ? view.focus
                    : "other",
            };
            const key = JSON.stringify(data);

            latest.view = data;

            if (key !== viewKey) {
                viewKey = key;
                append("view", data);
            }
        }),
        note: safe((kind) => {
            if (["help-open", "help-close", "copy-diagnostics"].includes(kind)) {
                append(kind, {});
            }
        }),
        report: safe(() => {
            const report = {
                kind: "pi-coop-terminal-diagnostics",
                schema: 1,
                elapsedMs: time(),
                diagnosticErrors: errors,
                counts: { ...counts },
                latest,
                droppedEvents: dropped,
                events: events.map((e) => ({
                    atMs: e.atMs,
                    lastMs: e.lastMs,
                    count: e.count,
                    kind: e.kind,
                    data: e.data,
                })),
            };
            let text = JSON.stringify(report, null, 2);

            while (encoder.encode(text).length > MAX_REPORT_BYTES && report.events.length > 1) {
                report.events.shift();
                report.droppedEvents++;
                text = JSON.stringify(report, null, 2);
            }

            return text;
        }, '{"kind":"pi-coop-terminal-diagnostics","schema":1,"error":"Diagnostics unavailable"}'),
        clear() {
            start = Date.now();
            events = [];
            dropped = 0;
            errors = 0;
            latest = {};
            counts = {};
            stateKey = "";
            snapshotKey = "";
            viewKey = "";
            aliases.clear();

            for (const key of Object.keys(aliasCounts)) {
                delete aliasCounts[key];
            }
        },
    };
}
