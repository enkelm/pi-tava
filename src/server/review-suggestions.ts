/** Markdown suggestion protocol and byte-preserving replacement of an immutable review range. */
import { reviewMessageParts } from "../../web/review-message.js";
import { HttpError } from "./errors.ts";

/** Only complete, top-level fenced code blocks with the exact suggestion info string are actions. */
export function reviewSuggestions(markdown: string): string[] {
    return reviewMessageParts(markdown).flatMap((part) =>
        part.type === "code" && part.suggestionIndex !== undefined ? [part.text] : [],
    );
}

/** CRLF is equivalent for evidence; saved bytes outside the selected lines are never normalized. */
export function replaceReviewRange(
    original: string,
    start: number,
    end: number,
    context: string,
    replacement: string,
): string {
    const bom = original.startsWith("\uFEFF") ? "\uFEFF" : "";
    const content = original.slice(bom.length);
    const records = content.match(/[^\n]*\n|[^\n]+$/g) ?? [];
    const lineText = (record: string) => record.replace(/\r?\n$/, "");
    const selected = records.slice(start - 1, end);
    // Diffs may include the file header in their first-line evidence; it is never part of replacement text.
    const evidence = context.replace(/\r\n/g, "\n");
    const expected =
        bom !== "" && start === 1 && evidence.startsWith(bom)
            ? evidence.slice(bom.length)
            : evidence;

    if (
        start < 1 ||
        end < start ||
        end > records.length ||
        selected.map(lineText).join("\n") !== expected
    ) {
        throw new HttpError(
            409,
            "The selected lines no longer match the review's complete context.",
        );
    }

    const ending = /\r?\n$/.exec(selected.at(-1)!)?.[0] ?? "";
    const newline = /\r?\n/.exec(selected.join(""))?.[0] ?? /\r?\n/.exec(content)?.[0] ?? "\n";
    const inserted =
        bom !== "" && start === 1 && replacement.startsWith(bom)
            ? replacement.slice(bom.length)
            : replacement;
    const body =
        inserted === "" ? "" : inserted.replace(/\r\n/g, "\n").replace(/\n/g, newline) + ending;
    let output = records.slice(0, start - 1).join("") + body + records.slice(end).join("");

    // Deleting the final unterminated line must not introduce an EOF newline on its predecessor.
    if (!content.endsWith("\n") && inserted === "" && end === records.length) {
        output = output.replace(/\r?\n$/, "");
    }

    return bom + output;
}
