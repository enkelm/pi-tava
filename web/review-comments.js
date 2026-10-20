// A native index of successfully delivered findings, attached by core to the actual Reviewer answer.
import { useId, useState } from "preact/hooks";
import { revealReviewThread, store } from "./store.js";
import { html, Icon } from "./ui.js";

const opened = new Map();

function location(comment) {
    const lines =
        comment.startLine === undefined || comment.startLine === comment.line
            ? `line ${comment.line}`
            : `lines ${comment.startLine}–${comment.line}`;

    return `${comment.path} · ${comment.side} ${lines}`;
}

export function DiffComments({ entry }) {
    const field = useId();
    const [, redraw] = useState(0);
    const comments = entry.diffComments ?? [];
    const { conversationId, view } = store.state;
    const key = `${conversationId}:${entry.id}`;
    const newest = view.order.findLast((id) => {
        const item = view.entries.get(id);

        return item?.kind === "assistant" && item.stopReason !== "toolUse";
    });
    const open = opened.get(key) ?? entry.id === newest;

    if (comments.length === 0) {
        return null;
    }

    return html`<section
        class=${`activity diff-comments ${open ? "open" : ""}`}
        aria-label="Diff comments"
    >
        <button
            type="button"
            class="activity-head"
            aria-expanded=${open}
            aria-controls=${`${field}-comments`}
            onClick=${() => {
                opened.delete(key);
                opened.set(key, !open);

                if (opened.size > 400) {
                    opened.delete(opened.keys().next().value);
                }

                redraw((value) => value + 1);
            }}
        >
            <${Icon} name="chevron" size=${14} class="chev" />
            <span class="activity-summary">Diff comments · ${comments.length}</span>
        </button>
        <ul id=${`${field}-comments`} class="diff-comments-list" hidden=${!open}>
            ${comments.map((comment) => {
                const thread =
                    comment.conversationId === conversationId
                        ? view.reviews?.threads.find((item) => item.id === comment.threadId)
                        : null;

                return html`<li key=${`${comment.conversationId}:${comment.commentId}`}>
                    <button
                        type="button"
                        class="diff-comment-link"
                        onClick=${() => revealReviewThread(comment)}
                    >
                        <span class="diff-comment-location">${location(comment)}</span>
                        <span class="diff-comment-excerpt">${comment.text}</span>
                        ${thread && html`<span class="diff-comment-status">${thread.resolved ? "Resolved" : "Open"}</span>`}
                    </button>
                </li>`;
            })}
        </ul>
    </section>`;
}
