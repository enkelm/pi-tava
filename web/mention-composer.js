// One completion path for side chat and review discussions. Sending and PiP admission stay with callers.
import { useId, useRef, useState } from "preact/hooks";
import { Avatar } from "./avatar.js";
import { canMentionPip } from "./pip-mentions.js";
import { store } from "./store.js";
import { html, Icon } from "./ui.js";

/** The active @query ends at the caret, not necessarily at the end of the draft. */
function mentionQuery(value, caret) {
    const match = /(^|\s)@([^\s@]{0,30})$/.exec(value.slice(0, caret));

    return match ? { query: match[2], start: caret - match[2].length - 1, end: caret } : null;
}

export function useMentionComposer({ text, onChange, input, enabled = true }) {
    const [mention, setMention] = useState(null);
    const [selected, setSelected] = useState(0);
    const composing = useRef(false);
    const listId = `${useId()}-mentions`;
    const { users, me } = store.state;
    const choices = [
        ...(canMentionPip() ? [{ name: "PiP", service: "pip" }] : []),
        ...users.filter((user) => user.id !== me?.id && user.name.toLowerCase() !== "pip"),
    ];
    const active =
        enabled && mention && text.slice(mention.start, mention.end) === `@${mention.query}`;
    const candidates = active
        ? choices
              .filter((user) => user.name.toLowerCase().includes(mention.query.toLowerCase()))
              .slice(0, 5)
        : [];
    const index = Math.min(selected, candidates.length - 1);

    const refresh = (event) => {
        const element = event.currentTarget;

        setMention(
            enabled && !composing.current && !event.isComposing
                ? mentionQuery(element.value, element.selectionStart ?? element.value.length)
                : null,
        );
        setSelected(0);
    };

    const pick = (user) => {
        if (!active) {
            return;
        }

        const at = mention.start + user.name.length + 2;

        onChange(`${text.slice(0, mention.start)}@${user.name} ${text.slice(mention.end)}`);
        setMention(null);
        requestAnimationFrame(() => {
            input.current?.focus();
            input.current?.setSelectionRange(at, at);
        });
    };

    const onKeyDown = (event) => {
        if (composing.current || event.isComposing || event.keyCode === 229) {
            // Consume the caller's send shortcut, but leave IME confirmation to the browser.
            return true;
        }

        if (event.key === "Escape" && active) {
            event.preventDefault();
            event.stopPropagation();
            setMention(null);

            return true;
        }

        if (!candidates.length) {
            return false;
        }

        if (event.key === "ArrowDown" || event.key === "ArrowUp") {
            event.preventDefault();
            setSelected(
                (index + (event.key === "ArrowDown" ? 1 : candidates.length - 1)) %
                    candidates.length,
            );

            return true;
        }

        if (!event.shiftKey && (event.key === "Tab" || event.key === "Enter")) {
            event.preventDefault();
            pick(candidates[index]);

            return true;
        }

        return false;
    };

    return {
        onKeyDown,
        inputProps: {
            "aria-autocomplete": "list",
            "aria-haspopup": "listbox",
            "aria-controls": candidates.length ? listId : undefined,
            "aria-activedescendant": candidates.length ? `${listId}-${index}` : undefined,
            onInput: (event) => {
                onChange(event.currentTarget.value);
                refresh(event);
            },
            onSelect: refresh,
            onClick: refresh,
            onKeyUp: (event) => {
                // Collapsed caret moves do not consistently fire a native select event.
                if (
                    ["ArrowLeft", "ArrowRight", "Home", "End"].includes(event.key) ||
                    (!candidates.length && ["ArrowUp", "ArrowDown"].includes(event.key))
                ) {
                    refresh(event);
                }
            },
            onCompositionStart: () => {
                composing.current = true;
                setMention(null);
            },
            onCompositionEnd: (event) => {
                composing.current = false;
                onChange(event.currentTarget.value);
                refresh(event);
            },
            onKeyDown,
        },
        list:
            candidates.length > 0 &&
            html`<div
                class="mention-list"
                id=${listId}
                role="listbox"
                aria-label="Mention someone"
            >
                ${candidates.map(
                    (user, at) => html`<button
                        type="button"
                        class=${`list-item ${at === index ? "mention-active" : ""}`}
                        role="option"
                        tabindex="-1"
                        id=${`${listId}-${at}`}
                        aria-selected=${at === index}
                        aria-label=${`Mention ${user.name}`}
                        onMouseDown=${(event) => event.preventDefault()}
                        onClick=${() => pick(user)}
                    >
                        <span>
                            ${
                                user.service === "pip"
                                    ? html`<${Icon} name="pip" size=${20} />`
                                    : html`<${Avatar} person=${user} size=${20} />`
                            }
                            ${user.name}
                        </span>
                        <span class="muted small">${user.service === "pip" ? "Answer here" : user.online ? "online" : ""}</span>
                    </button>`,
                )}
            </div>`,
    };
}
