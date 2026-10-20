// One literal-mention grammar for shared-answer admission and discussion highlighting.
import { marked } from "marked";

/** Keep source offsets even when Markdown removes list indentation or normalizes line endings. */
function literalRanges(text) {
    // Whitespace is immaterial to locating a token, not to recognizing Markdown or a mention.
    const compact = [];
    const offsets = [];

    for (let index = 0; index < text.length; index++) {
        if (!/\s/.test(text[index])) {
            compact.push(text[index]);
            offsets.push(index);
        }
    }

    const raw = compact.join("");
    const ranges = [];
    const exclude = (start, end) => ranges.push([offsets[start], offsets[end - 1] + 1]);

    const visit = (tokens, from, to) => {
        let cursor = from;

        for (const token of tokens) {
            const value = token.raw.replace(/\s/g, "");

            if (!value) {
                continue;
            }

            const start = raw.indexOf(value, cursor);
            const end = start + value.length;

            if (start < cursor || end > to) {
                // Never purchase work from a region we cannot map back to its literal source.
                exclude(from, to);

                return;
            }

            cursor = end;

            if (["code", "codespan", "blockquote"].includes(token.type)) {
                exclude(start, end);
            } else if (token.type === "list") {
                visit(token.items, start, end);
            } else if (token.tokens) {
                visit(token.tokens, start, end);
            } else if (token.type === "table") {
                // Cell token raw values can unescape pipes. Lex the intact raw table for inline code.
                visit(marked.Lexer.lexInline(token.raw), start, end);
            }
        }
    };

    visit(marked.lexer(text), 0, raw.length);

    return ranges;
}

export function pipMentionParts(text) {
    const matches = [...text.matchAll(/(^|[^\p{L}\p{N}_@\\])@pip(?![\p{L}\p{N}_])/giu)];

    if (!matches.length) {
        return [{ text }];
    }

    const ranges = literalRanges(text);
    const parts = [];
    let start = 0;

    for (const match of matches) {
        const at = match.index + match[1].length;

        if (ranges.some(([from, to]) => at >= from && at < to)) {
            continue;
        }

        parts.push({ text: text.slice(start, at) });
        parts.push({ text: text.slice(at, at + 4), mention: true });
        start = at + 4;
    }

    parts.push({ text: text.slice(start) });

    return parts;
}
