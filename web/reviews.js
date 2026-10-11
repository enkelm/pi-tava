// Local, immutable review rounds and discussion. Diff rendering stays in diff.js.
import { useEffect, useId, useRef, useState } from "preact/hooks";
import { actions, store, uid } from "./store.js";
import { html, Icon } from "./ui.js";

const VERDICTS = {
    pending: "Pending",
    commented: "Commented",
    approved: "Approved",
    changes_requested: "Changes requested",
    dismissed: "Dismissed",
};

/** Keep failed drafts; ignore responses after navigating away from their conversation. */
function useRequest(conversationId) {
    const [pending, setPending] = useState(false);
    const [error, setError] = useState("");
    const busy = useRef(false);
    const receipt = useRef(null);
    const mounted = useRef(true);

    useEffect(() => {
        mounted.current = true;

        return () => {
            mounted.current = false;
        };
    }, []);

    const run = async (work, success) => {
        if (busy.current) {
            return;
        }

        busy.current = true;
        setPending(true);
        setError("");

        try {
            const result = await work();

            receipt.current = null;

            if (mounted.current && store.state.conversationId === conversationId) {
                success?.(result);
            }
        } catch (cause) {
            if (mounted.current && store.state.conversationId === conversationId) {
                setError(cause?.message || "Could not save. Check your connection and try again.");
            }
        } finally {
            busy.current = false;

            if (mounted.current) {
                setPending(false);
            }
        }
    };

    // An explicit retry of the same failed draft reuses its receipt, including a lost response.
    const requestId = (payload) => {
        const key = JSON.stringify(payload);

        if (receipt.current?.key !== key) {
            receipt.current = { key, id: uid() };
        }

        return receipt.current.id;
    };

    return { pending, error, run, requestId, clearError: () => setError("") };
}

function RequestError({ error }) {
    return error ? html`<p class="rv-error" role="alert">${error}</p>` : null;
}

function ReviewTime({ at }) {
    const date = new Date(at);

    if (!at || !Number.isFinite(date.getTime())) {
        return null;
    }

    return html`<time class="rv-time" datetime=${date.toISOString()} title=${date.toLocaleString()}>
        ${date.toLocaleDateString([], { month: "short", day: "numeric" })} ${date.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })}
    </time>`;
}

/** Compare substance, not Pi attribution or the order returned by git. */
function fileSignature(changes) {
    return JSON.stringify(
        (changes.files ?? [])
            .map((file) => [
                file.path,
                file.kind,
                file.version ?? null,
                file.added ?? null,
                file.removed ?? null,
            ])
            .sort((a, b) => a[0].localeCompare(b[0])),
    );
}

function snapshotStatus(review, liveChanges) {
    if (!liveChanges) {
        return "unknown";
    }

    const saved = review.snapshot;
    const repo = saved?.repo;
    const live = liveChanges.repo;
    const cwd = store.state.view.agent?.cwd ?? store.state.view.conversation?.cwd;
    const savedCwd = review.cwd ?? saved?.cwd;

    const root = repo?.root?.replace(/\/+$/, "") ?? "";
    const folder = savedCwd?.replace(/\/+$/, "");
    // The server resolves symlinks for repo paths; cwd intentionally keeps the app's spelling.
    const relativeFolder =
        typeof review.scopePrefix === "string"
            ? review.scopePrefix.replace(/^\/+|\/+$/g, "")
            : folder && folder !== root && folder.startsWith(`${root}/`)
              ? folder.slice(root.length + 1)
              : "";
    const prefix = relativeFolder ? `${relativeFolder}/` : "";
    const scopedLive = prefix
        ? {
              ...liveChanges,
              files: liveChanges.files.filter((file) => file.path.startsWith(prefix)),
          }
        : liveChanges;

    if (
        !repo ||
        !live ||
        repo.root !== live.root ||
        (repo.head ?? null) !== (live.head ?? null) ||
        (repo.branch ?? null) !== (live.branch ?? null) ||
        (savedCwd !== undefined && cwd !== undefined && savedCwd !== cwd) ||
        (liveChanges.more ?? 0) !== (saved.more ?? 0) ||
        fileSignature(saved) !== fileSignature(scopedLive)
    ) {
        return "stale";
    }

    return "matching";
}

/** Controlled selector: opening Changes never selects a saved round on someone's behalf. */
export function ReviewsPanel({ active = true, liveChanges, selectedId, onSelect }) {
    if ((store.state.server?.localReviews ?? 0) < 1) {
        return null;
    }

    return html`<${ReviewsPanelBody}
        key=${store.state.conversationId}
        active=${active}
        liveChanges=${liveChanges}
        selectedId=${selectedId}
        onSelect=${onSelect}
        conversationId=${store.state.conversationId}
    />`;
}

function ReviewsPanelBody({ active, liveChanges, selectedId, onSelect, conversationId }) {
    const reviews = Array.isArray(store.state.view.reviews) ? store.state.view.reviews : [];
    const owner = store.state.me?.role === "owner";
    const [creating, setCreating] = useState(false);
    const [title, setTitle] = useState("");
    const request = useRequest(conversationId);
    const fieldId = useId();
    const review = reviews.find((round) => round.id === selectedId);
    const busy = store.state.view.live?.busy === true;
    const unavailable = !liveChanges
        ? "Loading working changes…"
        : !liveChanges.repo
          ? "A git repository is required to save a review."
          : liveChanges.files.length === 0
            ? "No uncommitted changes to review."
            : busy
              ? "Wait until Pi finishes before saving a review."
              : "";

    const create = (event) => {
        event.preventDefault();

        if (!active || unavailable || !title.trim()) {
            return;
        }

        request.run(
            () =>
                actions.createReview(
                    { requestId: request.requestId(title.trim()), title: title.trim() },
                    conversationId,
                ),
            (result) => {
                setTitle("");
                setCreating(false);
                onSelect?.(result.id);
            },
        );
    };

    return html`<section class="rv-panel" aria-label="Local reviews">
        <div class="rv-selector-row">
            <label class="rv-selector" for=${`${fieldId}-round`}>
                <span>Review</span>
                <select
                    id=${`${fieldId}-round`}
                    value=${selectedId ?? ""}
                    onChange=${(event) => onSelect?.(event.currentTarget.value || null)}
                >
                    <option value="">${store.state.me?.role === "viewer" ? "Select a saved review" : "Working changes"}</option>
                    ${reviews.map(
                        (round) => html`<option key=${round.id} value=${round.id}>
                            ${round.title} · ${round.status === "closed" ? "Closed" : "Open"}
                        </option>`,
                    )}
                    ${selectedId && !review && html`<option value=${selectedId}>Loading review…</option>`}
                </select>
            </label>
            ${
                owner &&
                html`<button
                type="button"
                class="button small rv-button"
                disabled=${!active || request.pending}
                aria-expanded=${creating}
                aria-controls=${`${fieldId}-create`}
                onClick=${() => {
                    setCreating(!creating);
                    request.clearError();
                }}
            >
                <${Icon} name="plus" size=${14} /> New review
            </button>`
            }
        </div>
        ${
            creating &&
            owner &&
            html`<form id=${`${fieldId}-create`} class="rv-form" onSubmit=${create}>
            <label for=${`${fieldId}-title`}>Review title</label>
            <input
                id=${`${fieldId}-title`}
                type="text"
                value=${title}
                maxlength="200"
                required
                disabled=${request.pending}
                onInput=${(event) => setTitle(event.currentTarget.value)}
                aria-describedby=${`${fieldId}-help`}
            />
            <p id=${`${fieldId}-help`} class="rv-hint">Saved uncommitted changes · local only</p>
            ${unavailable && html`<p class="rv-hint" role="status">${unavailable}</p>`}
            <${RequestError} error=${request.error} />
            <div class="rv-actions">
                <button
                    class="button primary small rv-button"
                    type="submit"
                    disabled=${!active || !!unavailable || !title.trim() || request.pending}
                >${request.pending ? "Saving snapshot…" : "Save review"}</button>
                <button
                    class="button ghost small rv-button"
                    type="button"
                    disabled=${request.pending}
                    onClick=${() => setCreating(false)}
                >Cancel</button>
            </div>
        </form>`
        }
        ${
            selectedId &&
            (review
                ? html`<${ReviewDetails}
                key=${review.id}
                review=${review}
                liveChanges=${liveChanges}
                active=${active}
                conversationId=${conversationId}
            />`
                : html`<p class="rv-hint" role="status">Loading saved review…</p>`)
        }
    </section>`;
}

function ReviewDetails({ review, liveChanges, active, conversationId }) {
    const { me, users } = store.state;
    const owner = me?.role === "owner";
    const writable = active && review.status === "open";
    const reviewers = Object.values(review.reviewers ?? {});
    const self = review.reviewers?.[me?.id];
    const unresolved = (review.threads ?? []).filter((thread) => !thread.resolved).length;
    const stale = snapshotStatus(review, liveChanges);
    const assignment = useRequest(conversationId);
    const [assignee, setAssignee] = useState("");
    const fieldId = useId();
    const available = users.filter(
        (user) =>
            !review.reviewers?.[user.id]?.active &&
            (!Array.isArray(user.sessions) || user.sessions.includes(conversationId)),
    );
    const canAssign = available.some((user) => user.id === assignee);
    const events = [...(review.events ?? [])].sort((a, b) => a.at - b.at);

    const assign = (event) => {
        event.preventDefault();

        if (!writable || !canAssign) {
            return;
        }

        assignment.run(
            () =>
                actions.manageReview(
                    review.id,
                    { action: "assign", userId: assignee, expectedRevision: review.rev },
                    conversationId,
                ),
            () => setAssignee(""),
        );
    };

    return html`<div class="rv-details">
        <div class="rv-heading">
            <h3>${review.title}</h3>
            <span class=${`rv-status ${review.status}`}>${review.status === "closed" ? "Closed" : "Open"}</span>
        </div>
        <p class="rv-hint">Immutable snapshot · local only · saved by ${review.name} <${ReviewTime} at=${review.createdAt} /></p>
        ${
            stale === "stale" &&
            html`<p class="rv-notice" role="status">
            Working changes or the working directory have changed. Saved approvals do not cover the current files.
        </p>`
        }
        ${
            stale === "unknown" &&
            html`<p class="rv-hint" role="status">
            ${me?.role === "viewer" ? "Saved snapshot only; current working changes are not shared in this view." : "Working changes are unavailable; verdicts cover only this saved snapshot."}
        </p>`
        }
        ${review.status === "closed" && html`<p class="rv-hint">This round is closed. Verdicts and discussion are read-only.</p>`}
        <section class="rv-reviewers" aria-label="Reviewers">
            <h4>Reviewers</h4>
            ${reviewers.length === 0 && html`<p class="rv-hint">No reviewers assigned yet.</p>`}
            <ul class="rv-reviewer-list">
                ${reviewers.map(
                    (reviewer) => html`<${ReviewerRow}
                    key=${reviewer.userId}
                    reviewer=${reviewer}
                    review=${review}
                    stale=${stale !== "matching"}
                    owner=${owner}
                    writable=${writable}
                    conversationId=${conversationId}
                />`,
                )}
            </ul>
            ${
                owner &&
                html`<details class="rv-manage">
                    <summary>Manage reviewers</summary>
                    <form class="rv-assignment" onSubmit=${assign}>
                        <label for=${`${fieldId}-assign`}>Assign reviewer</label>
                        <div class="rv-input-row">
                            <select
                                id=${`${fieldId}-assign`}
                                value=${assignee}
                                disabled=${!writable || assignment.pending || available.length === 0}
                                onChange=${(event) => setAssignee(event.currentTarget.value)}
                            >
                                <option value="">${available.length ? "Choose a person" : "Everyone is assigned"}</option>
                                ${available.map((user) => html`<option key=${user.id} value=${user.id}>${user.name}</option>`)}
                            </select>
                            <button
                                class="button small rv-button"
                                type="submit"
                                disabled=${!writable || !canAssign || assignment.pending}
                            >${assignment.pending ? "Assigning…" : "Assign"}</button>
                        </div>
                        <${RequestError} error=${assignment.error} />
                    </form>
                </details>`
            }
        </section>
        ${
            self?.active &&
            html`<${VerdictForm}
            review=${review}
            reviewer=${self}
            writable=${writable}
            conversationId=${conversationId}
        />`
        }
        <div class="rv-discussion">
            ${unresolved > 0 && html`<p class="rv-hint">${unresolved} unresolved ${unresolved === 1 ? "thread" : "threads"} across this review.</p>`}
            <${ReviewThreads} review=${review} />
        </div>
        <div class="rv-footer">
            ${
                owner &&
                html`<${ReviewLifecycle}
                review=${review}
                active=${active}
                unfinished=${unresolved > 0 || reviewers.some((reviewer) => reviewer.active && reviewer.state === "changes_requested")}
                conversationId=${conversationId}
            />`
            }
            <details class="rv-audit">
                <summary>Activity${events.length ? ` (${events.length})` : ""}</summary>
                ${events.length === 0 && html`<p class="rv-hint">No activity recorded.</p>`}
                <ol>
                    ${events.map(
                        (event, index) => html`<li key=${index}>
                        <span class="rv-name">${event.name}</span> ${event.text}
                        <${ReviewTime} at=${event.at} />
                    </li>`,
                    )}
                </ol>
            </details>
        </div>
    </div>`;
}

function ReviewerRow({ reviewer, review, stale, owner, writable, conversationId }) {
    const request = useRequest(conversationId);
    const [dismissing, setDismissing] = useState(false);
    const [reason, setReason] = useState("");
    const fieldId = useId();
    const manage = (action) =>
        request.run(() =>
            actions.manageReview(
                review.id,
                { action, userId: reviewer.userId, expectedRevision: review.rev },
                conversationId,
            ),
        );

    const dismiss = (event) => {
        event.preventDefault();

        if (!writable || !reason.trim()) {
            return;
        }

        request.run(
            () =>
                actions.manageReview(
                    review.id,
                    {
                        action: "dismiss",
                        userId: reviewer.userId,
                        reason: reason.trim(),
                        expectedRevision: review.rev,
                    },
                    conversationId,
                ),
            () => {
                setReason("");
                setDismissing(false);
            },
        );
    };

    return html`<li class=${`rv-reviewer ${!reviewer.active ? "removed" : ""}`}>
        <div class="rv-reviewer-head">
            <span class="rv-name">${reviewer.name}</span>
            <span class=${`rv-verdict ${reviewer.state} ${stale || !reviewer.active ? "historical" : ""}`}>
                ${VERDICTS[reviewer.state] ?? reviewer.state}
            </span>
            ${!reviewer.active && html`<span class="rv-status">Removed</span>`}
            ${stale && reviewer.state === "approved" && html`<span class="rv-hint">Snapshot only</span>`}
            <${ReviewTime} at=${reviewer.at} />
        </div>
        ${reviewer.text && html`<p class="rv-text">${reviewer.text}</p>`}
        ${
            owner &&
            html`<div class="rv-actions">
            <button
                class="button ghost small rv-button"
                type="button"
                disabled=${!writable || request.pending}
                aria-label=${`${reviewer.active ? "Remove" : "Re-add"} ${reviewer.name} as reviewer`}
                onClick=${() => manage(reviewer.active ? "remove" : "assign")}
            >${request.pending && !dismissing ? "Saving…" : reviewer.active ? "Remove" : "Re-add"}</button>
            ${
                reviewer.active &&
                !["pending", "dismissed"].includes(reviewer.state) &&
                html`<button
                class="button ghost small rv-button"
                type="button"
                disabled=${!writable || request.pending}
                aria-expanded=${dismissing}
                aria-label=${`Dismiss ${reviewer.name}'s verdict`}
                onClick=${() => {
                    setDismissing(!dismissing);
                    request.clearError();
                }}
            >Dismiss…</button>`
            }
        </div>`
        }
        ${
            dismissing &&
            owner &&
            html`<form class="rv-form" onSubmit=${dismiss}>
            <label for=${`${fieldId}-reason`}>Reason for dismissing ${reviewer.name}'s verdict</label>
            <textarea
                id=${`${fieldId}-reason`}
                rows="2"
                required
                value=${reason}
                disabled=${!writable || request.pending}
                onInput=${(event) => setReason(event.currentTarget.value)}
            ></textarea>
            <p class="rv-hint">Dismissal is recorded; it does not approve on their behalf.</p>
            <div class="rv-actions">
                <button
                    class="button small rv-button"
                    type="submit"
                    disabled=${!writable || !reason.trim() || request.pending}
                >${request.pending ? "Dismissing…" : "Dismiss verdict"}</button>
                <button
                    class="button ghost small rv-button"
                    type="button"
                    disabled=${request.pending}
                    onClick=${() => setDismissing(false)}
                >Cancel</button>
            </div>
        </form>`
        }
        <${RequestError} error=${request.error} />
    </li>`;
}

function VerdictForm({ review, reviewer, writable, conversationId }) {
    const [state, setState] = useState(
        ["approved", "changes_requested", "commented"].includes(reviewer.state)
            ? reviewer.state
            : "commented",
    );
    const [text, setText] = useState("");
    const request = useRequest(conversationId);
    const fieldId = useId();

    const submit = (event) => {
        event.preventDefault();

        if (!writable || !reviewer.active) {
            return;
        }

        request.run(
            () =>
                actions.submitReview(
                    review.id,
                    { state, text: text.trim(), expectedRevision: review.rev },
                    conversationId,
                ),
            () => setText(""),
        );
    };

    return html`<details class="rv-own-verdict">
        <summary>${reviewer.state === "pending" ? "Submit your review" : "Update your review"}</summary>
        <form class="rv-form" onSubmit=${submit}>
        <label for=${`${fieldId}-state`}>Verdict</label>
        <select
            id=${`${fieldId}-state`}
            value=${state}
            disabled=${!writable || request.pending}
            onChange=${(event) => setState(event.currentTarget.value)}
        >
            <option value="commented">Commented</option>
            <option value="approved">Approved</option>
            <option value="changes_requested">Changes requested</option>
        </select>
        <label for=${`${fieldId}-text`}>Review note</label>
        <textarea
            id=${`${fieldId}-text`}
            value=${text}
            rows="2"
            disabled=${!writable || request.pending}
            onInput=${(event) => setText(event.currentTarget.value)}
        ></textarea>
        <${RequestError} error=${request.error} />
        <div class="rv-actions">
            <button
                class="button primary small rv-button"
                type="submit"
                disabled=${!writable || request.pending}
            >${request.pending ? "Submitting…" : "Submit review"}</button>
        </div>
        </form>
    </details>`;
}

function ReviewLifecycle({ review, active, unfinished, conversationId }) {
    const [closing, setClosing] = useState(false);
    const [reason, setReason] = useState("");
    const request = useRequest(conversationId);
    const fieldId = useId();

    const close = (event) => {
        event.preventDefault();

        if (!active || (unfinished && !reason.trim())) {
            return;
        }

        request.run(
            () =>
                actions.manageReview(
                    review.id,
                    { action: "close", reason: reason.trim(), expectedRevision: review.rev },
                    conversationId,
                ),
            () => {
                setClosing(false);
                setReason("");
            },
        );
    };

    return html`<div class="rv-lifecycle">
        ${
            review.status === "closed"
                ? html`<button
                class="button small rv-button"
                type="button"
                disabled=${!active || request.pending}
                onClick=${() => request.run(() => actions.manageReview(review.id, { action: "reopen", expectedRevision: review.rev }, conversationId))}
            >${request.pending ? "Reopening…" : "Reopen review"}</button>`
                : html`<button
                class="button ghost small rv-button"
                type="button"
                disabled=${!active || request.pending}
                aria-expanded=${closing}
                onClick=${() => {
                    setClosing(!closing);
                    request.clearError();
                }}
            >Close review…</button>`
        }
        ${
            closing &&
            review.status === "open" &&
            html`<form class="rv-form" onSubmit=${close}>
            <label for=${`${fieldId}-close`}>Close reason${unfinished ? " (required)" : " (optional)"}</label>
            <textarea
                id=${`${fieldId}-close`}
                rows="2"
                value=${reason}
                required=${unfinished}
                disabled=${!active || request.pending}
                onInput=${(event) => setReason(event.currentTarget.value)}
            ></textarea>
            ${unfinished && html`<p class="rv-hint">There are requested changes or unresolved threads. Explain why this round is being closed.</p>`}
            <div class="rv-actions">
                <button
                    class="button small rv-button"
                    type="submit"
                    disabled=${!active || request.pending || (unfinished && !reason.trim())}
                >${request.pending ? "Closing…" : "Close review"}</button>
                <button
                    class="button ghost small rv-button"
                    type="button"
                    disabled=${request.pending}
                    onClick=${() => setClosing(false)}
                >Cancel</button>
            </div>
        </form>`
        }
        <${RequestError} error=${request.error} />
    </div>`;
}

/** General-only when path is null; file threads and optional line composer otherwise. */
export function ReviewThreads({ review, path = null, anchor = null, onAnchorChange }) {
    if (!review || (store.state.server?.localReviews ?? 0) < 1) {
        return null;
    }

    const conversationId = store.state.conversationId;

    return html`<${ReviewThreadsBody}
        key=${`${conversationId}:${review.id}:${path ?? ""}`}
        review=${review}
        path=${path}
        anchor=${anchor}
        onAnchorChange=${onAnchorChange}
        conversationId=${conversationId}
    />`;
}

function ReviewThreadsBody({ review, path, anchor, onAnchorChange, conversationId }) {
    const threads = (review.threads ?? []).filter((thread) => (thread.path ?? null) === path);
    const writable = review.status === "open" && !!store.state.me;
    const [composing, setComposing] = useState(false);
    const [text, setText] = useState("");
    const request = useRequest(conversationId);
    const input = useRef(null);
    const fieldId = useId();
    const lineAnchor =
        path !== null &&
        ["old", "new"].includes(anchor?.side) &&
        Number.isInteger(anchor?.line) &&
        anchor.line > 0;
    const shown = composing || lineAnchor;
    const location =
        path === null
            ? "General discussion"
            : lineAnchor
              ? `${path} · ${anchor.side} line ${anchor.line}`
              : path;

    useEffect(() => {
        if (lineAnchor && writable) {
            setComposing(true);
            input.current?.focus();
        }
    }, [anchor?.side, anchor?.line, writable]);

    const submit = (event) => {
        event.preventDefault();

        if (!writable || !text.trim()) {
            return;
        }

        const payload = {
            text: text.trim(),
            ...(path === null ? {} : { path }),
            ...(lineAnchor ? { side: anchor.side, line: anchor.line } : {}),
        };

        request.run(
            () =>
                actions.reviewComment(
                    review.id,
                    { ...payload, requestId: request.requestId(payload) },
                    conversationId,
                ),
            () => {
                setText("");
                setComposing(false);
                onAnchorChange?.(null);
            },
        );
    };

    return html`<section
        class=${`rv-threads ${path === null && threads.length === 0 ? "rv-empty" : ""}`}
        aria-label=${path === null ? "General discussion" : `Discussion on ${path}`}
    >
        <h4>${path === null ? "General discussion" : "File discussion"}</h4>
        ${path !== null && threads.length === 0 && html`<p class="rv-hint">No comments on this file yet.</p>`}
        <div class="rv-thread-list">
            ${threads.map(
                (thread) => html`<${ReviewThread}
                key=${thread.id}
                review=${review}
                thread=${thread}
                writable=${writable}
                conversationId=${conversationId}
            />`,
            )}
        </div>
        ${
            writable &&
            !shown &&
            html`<button
            class="button small rv-button"
            type="button"
            onClick=${() => setComposing(true)}
        ><${Icon} name="chat" size=${14} /> ${path === null ? "Start discussion" : "Comment on file"}</button>`
        }
        ${
            shown &&
            (writable || text.length > 0) &&
            html`<form class="rv-form rv-comment-form" onSubmit=${submit}>
            <label for=${`${fieldId}-comment`}>${path === null ? "New discussion" : `Comment on ${location}`}</label>
            ${
                lineAnchor &&
                html`<button
                class="link rv-cancel-line"
                type="button"
                disabled=${request.pending}
                onClick=${() => onAnchorChange?.(null)}
            >Cancel line selection</button>`
            }
            <textarea
                id=${`${fieldId}-comment`}
                ref=${input}
                rows="3"
                required
                value=${text}
                disabled=${!writable || request.pending}
                onInput=${(event) => setText(event.currentTarget.value)}
            ></textarea>
            <${RequestError} error=${request.error} />
            <div class="rv-actions">
                <button
                    class="button primary small rv-button"
                    type="submit"
                    disabled=${!writable || !text.trim() || request.pending}
                >${request.pending ? "Posting…" : "Post comment"}</button>
                <button
                    class="button ghost small rv-button"
                    type="button"
                    disabled=${request.pending}
                    onClick=${() => {
                        setComposing(false);
                        onAnchorChange?.(null);
                    }}
                >Cancel</button>
            </div>
        </form>`
        }
    </section>`;
}

function ThreadLocation({ thread }) {
    if (!thread.path) {
        return null;
    }

    return html`<span class="rv-location">
        ${thread.path}${thread.line ? ` · ${thread.side} line ${thread.line}` : " · file"}
    </span>`;
}

function CommentText({ comment }) {
    return html`<div class="rv-comment">
        <div class="rv-comment-meta">
            <span class="rv-name">${comment.name}</span>
            <${ReviewTime} at=${comment.at} />
        </div>
        <p class="rv-text">${comment.text}</p>
    </div>`;
}

function ReviewThread({ review, thread, writable, conversationId }) {
    const { me } = store.state;
    const request = useRequest(conversationId);
    const canResolve =
        !!me &&
        (me.role === "owner" ||
            thread.userId === me.id ||
            review.reviewers?.[me.id]?.active === true);
    const body = html`<div class="rv-thread-body">
        <${ThreadLocation} thread=${thread} />
        <${CommentText} comment=${thread} />
        <div class="rv-replies">
            ${(thread.replies ?? []).map((reply) => html`<${CommentText} key=${reply.id} comment=${reply} />`)}
        </div>
        <div class="rv-thread-controls">
            <${ReplyForm}
                review=${review}
                thread=${thread}
                writable=${writable}
                conversationId=${conversationId}
            />
            ${
                canResolve &&
                html`<button
                class="button ghost small rv-button"
                type="button"
                disabled=${!writable || request.pending}
                onClick=${() =>
                    request.run(() =>
                        actions.resolveReviewThread(
                            review.id,
                            {
                                threadId: thread.id,
                                resolved: !thread.resolved,
                                expectedRevision: review.rev,
                            },
                            conversationId,
                        ),
                    )}
            >${request.pending ? "Saving…" : thread.resolved ? "Reopen thread" : "Resolve thread"}</button>`
            }
        </div>
        <${RequestError} error=${request.error} />
    </div>`;

    return thread.resolved
        ? html`<details class="rv-thread resolved">
            <summary>
                <${Icon} name="check" size=${14} />
                <span>Resolved · ${thread.name}${thread.line ? ` · ${thread.side} line ${thread.line}` : ""}</span>
                <span class="rv-hint">${1 + (thread.replies?.length ?? 0)} ${thread.replies?.length ? "comments" : "comment"}</span>
            </summary>
            ${body}
        </details>`
        : html`<article class="rv-thread">${body}</article>`;
}

function ReplyForm({ review, thread, writable, conversationId }) {
    const [open, setOpen] = useState(false);
    const [text, setText] = useState("");
    const request = useRequest(conversationId);
    const fieldId = useId();

    const submit = (event) => {
        event.preventDefault();

        if (!writable || !text.trim()) {
            return;
        }

        request.run(
            () =>
                actions.reviewComment(
                    review.id,
                    {
                        requestId: request.requestId(text.trim()),
                        threadId: thread.id,
                        text: text.trim(),
                    },
                    conversationId,
                ),
            () => {
                setText("");
                setOpen(false);
            },
        );
    };

    if (!open) {
        return writable
            ? html`<button
            class="button ghost small rv-button"
            type="button"
            aria-label=${`Reply to ${thread.name}`}
            onClick=${() => setOpen(true)}
        >Reply</button>`
            : null;
    }

    return html`<form class="rv-form rv-reply-form" onSubmit=${submit}>
        <label for=${`${fieldId}-reply`}>Reply to ${thread.name}</label>
        <textarea
            id=${`${fieldId}-reply`}
            rows="2"
            required
            value=${text}
            disabled=${!writable || request.pending}
            onInput=${(event) => setText(event.currentTarget.value)}
        ></textarea>
        <${RequestError} error=${request.error} />
        <div class="rv-actions">
            <button
                class="button primary small rv-button"
                type="submit"
                disabled=${!writable || !text.trim() || request.pending}
            >${request.pending ? "Posting…" : "Post reply"}</button>
            <button
                class="button ghost small rv-button"
                type="button"
                disabled=${request.pending}
                onClick=${() => setOpen(false)}
            >Cancel</button>
        </div>
    </form>`;
}
