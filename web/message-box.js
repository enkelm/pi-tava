// Shared message-box presentation. Callers own drafts, permissions and delivery; no room or storage access.
import { useLayoutEffect } from "preact/hooks";
import { html, Icon, Spinner } from "./ui.js";

export function MessageBox({
    inputRef,
    input,
    before,
    children,
    class: className = "",
    ...events
}) {
    useLayoutEffect(() => {
        const element = inputRef.current;

        if (!element) {
            return;
        }

        element.style.height = "auto";
        element.style.height = `${Math.min(element.scrollHeight, innerHeight * 0.4)}px`;
    }, [input.value]);

    return html`<div
        class=${`composer ${className}`}
        onClick=${(event) => {
            // Padding and gaps are part of the text target; toolbar buttons keep their own focus.
            if (
                event.target === event.currentTarget ||
                event.target.classList.contains("composer-row")
            ) {
                inputRef.current?.focus();
            }
        }}
        ...${events}
    >
        ${before}
        <textarea ref=${inputRef} rows="1" ...${input}></textarea>
        <div class="composer-row">${children}</div>
    </div>`;
}

export function SendButton({ sending, label = "Send", icon = "send", ...props }) {
    return html`<button class="round send" aria-label=${label} ...${props}>
        ${sending ? html`<${Spinner} />` : html`<${Icon} name=${icon} size=${18} />`}
    </button>`;
}
