/** Read and replace a queued input's main text without changing its speaker, attachments, or other content parts. */
import type { UserInput } from "@earendil-works/pi-durable";
import {
    ATTACHMENTS_HEADING,
    FILE_BLOCK,
    FROM_PREFIX,
    isAgentAnswer,
    isWorkItemEvent,
} from "./entry-format.ts";

export function queuedInputText(content: UserInput): {
    readOnly: boolean;
    text: string;
    editableText: string;
    hasAttachments: boolean;
    replace(text: string): UserInput;
} {
    // Pocket puts the main text first. Do not mistake an inline file for it in an image-only input.
    const index =
        typeof content === "string"
            ? -1
            : content.findIndex(
                  (part) => part.type === "text" && !part.text.startsWith(FILE_BLOCK),
              );
    const part = typeof content === "string" ? undefined : content[index];
    const text = typeof content === "string" ? content : part?.type === "text" ? part.text : "";
    const prefix = text.match(FROM_PREFIX)?.[0] ?? "";
    // Attachment-only submissions were trimmed on admission, removing the heading's leading blank lines.
    const attachmentOnly = text.slice(prefix.length).startsWith(ATTACHMENTS_HEADING.trimStart());
    const at = attachmentOnly ? prefix.length : text.indexOf(ATTACHMENTS_HEADING, prefix.length);
    const tail = at < 0 ? "" : text.slice(at);
    const editableText = text.slice(prefix.length, at < 0 ? undefined : at);
    const metadata = (typeof content === "string" ? undefined : content[0]) as
        { pocketAppEvent?: unknown; pocketAgentAnswer?: unknown } | undefined;
    // Editing the body cannot retain trusted service authorship or its immutable decision receipt.
    const readOnly =
        isWorkItemEvent(metadata?.pocketAppEvent) || isAgentAnswer(metadata?.pocketAgentAnswer);

    return {
        readOnly,
        text,
        editableText,
        hasAttachments:
            tail !== "" ||
            (typeof content !== "string" &&
                content.some(
                    (part) =>
                        part.type === "image" ||
                        (part.type === "text" && part.text.startsWith(FILE_BLOCK)),
                )),
        replace(edited) {
            const separator = attachmentOnly && edited !== "" ? "\n\n" : "";
            const main = `${prefix}${edited}${separator}${tail}`;

            if (typeof content === "string") {
                return main;
            }

            if (index < 0) {
                return [{ type: "text", text: main }, ...content];
            }

            return content.map((part, position) =>
                position === index && part.type === "text" ? { ...part, text: main } : part,
            );
        },
    };
}
