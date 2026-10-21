// The private Work Item chat presents durable asks beside its ordinary composer.
import { useRef, useState } from "preact/hooks";
import { actions, attempt } from "./store.js";
import { html, Markdown } from "./ui.js";

export function PipQuestion({
    question,
    conversationId,
    showText = question?.entryId === undefined,
}) {
    const [sending, setSending] = useState(false);
    const flight = useRef(false);

    if (!question || (!showText && !question.answer)) {
        return null;
    }

    return html`<section class="assistant" aria-label="PiP question">
        ${showText && html`<${Markdown} text=${question.text} />`}
        ${
            question.answer &&
            html`<div>
                <p class="muted small">Your saved reply</p>
                <${Markdown} text=${question.answer.text} />
                ${
                    !question.answer.legacy &&
                    html`<p class="muted small">
                        After Stop or a Limits change, send a new reply below to make a new decision.
                    </p>`
                }
                <button
                    class="button"
                    disabled=${sending}
                    onClick=${async () => {
                        if (flight.current) {
                            return;
                        }

                        flight.current = true;
                        setSending(true);
                        await attempt(() => actions.retryPipAnswer(conversationId, question));
                        flight.current = false;
                        setSending(false);
                    }}
                >
                    ${sending ? "Sending…" : "Retry saved reply"}
                </button>
            </div>`
        }
    </section>`;
}
