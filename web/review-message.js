// Pure review Markdown protocol shared by native controls and authoritative server application.
import { marked } from "marked";

/** Closed top-level fences alone are code blocks; suggestion indices count only exact-info actions. */
export function reviewMessageParts(markdown) {
    const parts = [];
    let prose = "";
    let index = 0;

    const flush = () => {
        if (prose) {
            parts.push({ type: "text", text: prose.trimEnd() });
            prose = "";
        }
    };

    for (const token of marked.lexer(markdown)) {
        const opening = token.type === "code" && /^ {0,3}(`{3,}|~{3,})[^\n]*\n/.exec(token.raw);
        const fence = opening && opening[1];
        const closed =
            fence &&
            new RegExp(`(?:^|\\n) {0,3}${fence[0]}{${fence.length},}[ \\t]*(?:\\n)?$`).test(
                token.raw.slice(opening[0].length),
            );

        if (!closed) {
            prose += token.raw;
            continue;
        }

        flush();
        parts.push({
            type: "code",
            text: token.text,
            ...(token.lang === "suggestion" ? { suggestionIndex: index++ } : {}),
        });
    }

    flush();

    return parts;
}
