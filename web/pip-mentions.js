// Shared-discussion PiP presentation only: admission, roles and execution remain server-owned.
import { marked } from "marked";
import { pipMentionParts } from "./pip-mention-text.js";
import { canSteer, store } from "./store.js";
import { html } from "./ui.js";

export const canMentionPip = () =>
    !!store.state.me &&
    canSteer() &&
    !!store.state.server?.pipMentions &&
    store.state.server?.pipEnabled === true;

/** Highlight explicit prose mentions, not quoted/code examples or longer @names. */
export function PipMentionText({ text, plain = (value) => value }) {
    return pipMentionParts(text).map((part) =>
        part.mention ? html`<span class="mention">${part.text}</span>` : plain(part.text),
    );
}

/** Human highlights use stored chat recipients, or the visible people for review discussions. */
function PersonMentions({ text, mentions, users, me }) {
    const named = users
        .filter(
            (user) =>
                user.name.toLowerCase() !== "pip" && (!mentions || mentions.includes(user.id)),
        )
        .sort((a, b) => b.name.length - a.name.length);
    const parts = [];
    let rest = text;

    while (rest.length > 0) {
        const lower = rest.toLowerCase();
        let best = null;

        for (const user of named) {
            const needle = `@${user.name.toLowerCase()}`;
            let at = lower.indexOf(needle);

            while (at !== -1) {
                if (
                    !/[\p{L}\p{N}_@\\]/u.test(rest[at - 1] ?? "") &&
                    !/[\p{L}\p{N}_]/u.test(rest[at + needle.length] ?? "")
                ) {
                    if (best === null || at < best.at) {
                        best = { at, user };
                    }

                    break;
                }

                at = lower.indexOf(needle, at + 1);
            }
        }

        if (best === null) {
            parts.push(rest);
            break;
        }

        const length = best.user.name.length + 1;

        parts.push(rest.slice(0, best.at));
        parts.push(
            html`<span class=${`mention ${best.user.id === me?.id ? "me" : ""}`}>${rest.slice(best.at, best.at + length)}</span>`,
        );
        rest = rest.slice(best.at + length);
    }

    return parts;
}

/** Shared presentation; highlighting a name never grants execution authority. */
export function DiscussionMentionText({
    text,
    mentions,
    users = store.state.users,
    me = store.state.me,
    links = false,
}) {
    const plain = (part) =>
        links
            ? marked.Lexer.lexInline(part).map((token) =>
                  token.type === "link" && /^https?:\/\//i.test(token.href)
                      ? html`<a href=${token.href} target="_blank" rel="noopener noreferrer">${token.text}</a>`
                      : html`<${PersonMentions} text=${token.raw} mentions=${mentions} users=${users} me=${me} />`,
              )
            : html`<${PersonMentions} text=${part} mentions=${mentions} users=${users} me=${me} />`;

    return html`<${PipMentionText} text=${text} plain=${plain} />`;
}

const unavailable = {
    paused: "PiP is paused.",
    model: "PiP needs a Collaborator model. The owner can choose one in Settings → PiP.",
    budget: "PiP cannot answer within the current spending limit.",
    permission: "The sender’s role cannot request a PiP answer.",
    turn: "Only the current driver can ask PiP.",
    capacity: "PiP is at capacity.",
    source: "PiP cannot access this discussion.",
};

/** Fixed native status copy: never render provider messages or other raw job errors. */
export function PipMentionStatus({ state }) {
    if (!state) {
        return null;
    }

    const label = {
        queued: "PiP · queued",
        working: "PiP · answering…",
        answered: "PiP · answered",
        unavailable: `${unavailable[state.reason] ?? "PiP is unavailable."} The message was posted.`,
        failed: "PiP could not answer. The message was posted.",
        interrupted: "PiP’s answer was interrupted. The message was posted.",
    }[state.status];

    return label
        ? html`<span class="muted small" role="status" aria-live="polite">${label}</span>`
        : null;
}
