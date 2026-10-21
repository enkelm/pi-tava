// Native Work Item limits stay available independently of browser modules and extension safe mode.
import { h } from "preact";
import { useEffect, useRef, useState } from "preact/hooks";
import { api, closeSheet, handoffsAvailable, store } from "../store.js";
import { html, Loader, Sheet } from "../ui.js";

// A dismissed/reopened sheet waits for an uncertain save, then reads; it never replays the mutation.
const pending = new Map();

// Limits belong to the selected sidebar item, not whichever conversation is underneath it.
function target({ userId, id, workItemId, viewId }) {
    const state = store.state;
    const row = state.sessions.find((each) => each.id === id);

    return handoffsAvailable() &&
        state.me?.id === userId &&
        state.me?.role === "owner" &&
        state.conversationId === viewId &&
        typeof workItemId === "string" &&
        row !== undefined &&
        row.workItemId === workItemId &&
        !row.archived &&
        row.supervisor !== undefined
        ? row
        : undefined;
}

function Form({ sheet, close }) {
    const { id, userId, workItemId, viewId, opening } = sheet;
    const key = `${userId}.${id}`;
    const [data, setData] = useState(null);
    const [allowance, setAllowance] = useState("");
    const [error, setError] = useState("");
    const [busy, setBusy] = useState(false);
    const [retry, setRetry] = useState(0);
    const mounted = useRef(false);
    const submitting = useRef(false);
    const selected = () => target(sheet);
    const live = () => mounted.current && store.state.sheet === sheet && selected() !== undefined;

    useEffect(() => {
        mounted.current = true;
        const stop = new AbortController();
        let cancelled = false;

        setData(null);
        setError("");

        const load = async () => {
            await pending.get(key)?.catch(() => {});

            if (cancelled || !live()) {
                return;
            }

            try {
                const result = await api(`c/${id}/orchestrator`, undefined, {
                    signal: stop.signal,
                });

                if (!cancelled && live()) {
                    const item = result.orchestration;

                    if (
                        item?.workItemId !== workItemId ||
                        item.conversationId !== selected()?.supervisor.conversationId
                    ) {
                        throw new Error("This Work Item changed. Reopen its limits.");
                    }

                    setData(result);
                    setAllowance(
                        item?.maxCost == null ? "" : String(Math.max(0, item.maxCost - item.spent)),
                    );
                }
            } catch (failure) {
                if (!cancelled && live()) {
                    setError(failure.message);
                }
            }
        };

        load();

        return () => {
            cancelled = true;
            mounted.current = false;
            stop.abort();
        };
    }, [id, userId, workItemId, viewId, opening, retry]);

    const save = async (event) => {
        event.preventDefault();
        const budget = allowance.trim() === "" ? null : Number(allowance);

        if (budget !== null && (!Number.isFinite(budget) || budget <= 0)) {
            setError("Leave blank or enter a positive dollar amount.");

            return;
        }

        if (!live() || !data?.orchestration || submitting.current || pending.has(key)) {
            return;
        }

        const grant = selected().supervisor;

        if (
            grant.conversationId !== data.orchestration.conversationId ||
            grant.epoch !== data.orchestration.epoch ||
            grant.status !== data.orchestration.status
        ) {
            setError("This Work Item changed. Reload limits before saving.");
            setData(null);

            return;
        }

        submitting.current = true;
        setBusy(true);
        const flight = api(`c/${id}/orchestrator`, {
            action: "limits",
            budget,
            expected: {
                workItemId,
                conversationId: data.orchestration.conversationId,
                epoch: data.orchestration.epoch,
            },
        });

        pending.set(key, flight);

        try {
            await flight;

            if (live()) {
                close();
            }
        } catch (failure) {
            if (live()) {
                setError(
                    `${failure.message} The change may have reached the server. Reload limits before retrying.`,
                );
                setData(null);
            }
        } finally {
            if (pending.get(key) === flight) {
                pending.delete(key);
            }

            submitting.current = false;
            setBusy(false);
        }
    };

    const item = data?.orchestration;

    return html`<form class="work-item-limits" onSubmit=${save}>
        ${!data && !error && html`<${Loader} label="Loading limits" />`}
        ${error && html`<p class="error-box" role="alert">${error}</p>`}
        ${
            item &&
            html`
                <p class="muted small">
                    ${`$${Number(item.spent).toFixed(2)} spent · ${item.maxCost == null ? "No work cost cap" : `$${Number(item.maxCost).toFixed(2)} work cap`}`}
                </p>
                <label class="field">
                    <span class="label">Additional spend ($, optional)</span>
                    <input
                        type="number"
                        inputmode="decimal"
                        min="0.01"
                        step="0.01"
                        value=${allowance}
                        disabled=${busy}
                        onInput=${(event) => setAllowance(event.currentTarget.value)}
                    />
                </label>
                <p class="muted small">
                    ${"Blank removes the work cap; account limits still apply. Saving returns this Work Item to human control. Send a new message in its PiP Thread to activate PiP."}
                </p>
                <button class="button primary" type="submit" disabled=${busy}>
                    ${busy ? "Saving…" : "Save limit"}
                </button>
            `
        }
        ${
            error &&
            html`<button
                class="button"
                type="button"
                disabled=${busy}
                onClick=${() => setRetry((value) => value + 1)}
            >
                Reload limits
            </button>`
        }
        <button class="button" type="button" onClick=${close}>Close</button>
    </form>`;
}

export function WorkItemLimitsSheet({ sheet }) {
    if (target(sheet) === undefined) {
        return null;
    }

    const close = () => {
        if (store.state.sheet === sheet) {
            closeSheet();
        }
    };

    return html`<${Sheet} title="Work Item limits" onClose=${close}>
        ${h(Form, { sheet, close, key: JSON.stringify([sheet.userId, sheet.id, sheet.opening]) })}
    <//>`;
}
