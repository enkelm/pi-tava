// Bundled lazily by the daemon, never loaded directly by the app. All editor dependencies stay local.
export { basicSetup } from "codemirror";
export { EditorState, Compartment } from "@codemirror/state";
export { EditorView, keymap } from "@codemirror/view";
export { startCompletion } from "@codemirror/autocomplete";
export { setDiagnostics } from "@codemirror/lint";
export {
    LSPClient,
    serverCompletion,
    serverDiagnostics,
    hoverTooltips,
    signatureHelp,
    formatDocument,
    formatKeymap,
} from "@codemirror/lsp-client";
import { javascript } from "@codemirror/lang-javascript";
import { json } from "@codemirror/lang-json";
import { html } from "@codemirror/lang-html";
import { css } from "@codemirror/lang-css";
import { markdown } from "@codemirror/lang-markdown";
import { python } from "@codemirror/lang-python";
import { rust } from "@codemirror/lang-rust";
import { cpp } from "@codemirror/lang-cpp";
import { yaml } from "@codemirror/lang-yaml";
import { HighlightStyle, syntaxHighlighting } from "@codemirror/language";
import { tags } from "@lezer/highlight";

export const syntaxTheme = syntaxHighlighting(
    HighlightStyle.define([
        { tag: tags.keyword, color: "var(--hl-kw)" },
        { tag: [tags.string, tags.special(tags.string)], color: "var(--hl-str)" },
        { tag: [tags.number, tags.bool, tags.null], color: "var(--hl-num)" },
        { tag: tags.function(tags.variableName), color: "var(--hl-fn)" },
        { tag: [tags.typeName, tags.className], color: "var(--hl-type)" },
        { tag: tags.operator, color: "var(--hl-op)" },
        { tag: tags.tagName, color: "var(--hl-tag)" },
        { tag: tags.comment, color: "var(--muted)" },
        { tag: tags.heading, fontWeight: "bold" },
    ]),
);

export function languageFor(path) {
    if (/\.[cm]?[jt]sx?$/i.test(path)) {
        return javascript({ typescript: /\.[cm]?tsx?$/i.test(path), jsx: /x$/i.test(path) });
    }

    if (/\.json[cl]?$/i.test(path)) {
        return json();
    }

    if (/\.html?$/i.test(path)) {
        return html();
    }

    if (/\.css$/i.test(path)) {
        return css();
    }

    if (/\.(md|markdown|mdx)$/i.test(path)) {
        return markdown();
    }

    if (/\.pyi?$/i.test(path)) {
        return python();
    }

    if (/\.rs$/i.test(path)) {
        return rust();
    }

    if (/\.(c|h|cc|cpp|hpp)$/i.test(path)) {
        return cpp();
    }

    if (/\.ya?ml$/i.test(path)) {
        return yaml();
    }

    return [];
}
