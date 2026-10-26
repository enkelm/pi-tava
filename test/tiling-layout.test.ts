// Offline responsive policy, not cascade computation, pixel geometry, or iPad rendering proof.
// The browser theme tests own rendered frames; this guards the previously uncovered 768–959px range.
// Read actual CSS rules and their enclosing width queries without adding production test seams.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { cssLanguage } from "@codemirror/lang-css";
import type { SyntaxNode } from "@lezer/common";

const css = readFileSync(new URL("../web/style.css", import.meta.url), "utf8");
const tree = cssLanguage.parser.parse(css);
const rules: {
    selectors: string[];
    media: SyntaxNode[];
    declarations: Map<string, string>;
}[] = [];
const text = (node: SyntaxNode) => css.slice(node.from, node.to).trim();
const sidebar = ".sidebar";
const layout = ':root[data-tiling="on"] .layout';
const frame = ':root[data-tiling="on"] .window';
const focus = ':root[data-tiling="on"][data-focus="sidebar"] .sidebar';

tree.iterate({
    enter(node) {
        if (node.name !== "RuleSet") {
            return;
        }

        const block = node.node.getChild("Block")!;
        const selectors = css
            .slice(node.from, block.from)
            .trim()
            .split(/,\s*(?![^()]*\))/);

        if (!selectors.some((selector) => [sidebar, layout, frame, focus].includes(selector))) {
            return;
        }

        const declarations = new Map<string, string>();
        const media: SyntaxNode[] = [];

        for (let parent = node.node.parent; parent; parent = parent.parent) {
            if (parent.name === "MediaStatement") {
                media.push(parent);
            }
        }

        for (const declaration of block.getChildren("Declaration")) {
            const name = declaration.getChild("PropertyName")!;

            declarations.set(
                text(name),
                css
                    .slice(name.to, declaration.to)
                    .replace(/^\s*:\s*/, "")
                    .trim(),
            );
        }

        rules.push({ selectors, media, declarations });
    },
});

function widthQuery(query: SyntaxNode, width: number): boolean {
    if (query.name === "BinaryQuery") {
        assert.equal(text(query.getChild("LogicOp")!), "and", "width ranges must be conjunctive");

        return widthQuery(query.firstChild!, width) && widthQuery(query.lastChild!, width);
    }

    assert.equal(query.name, "FeatureQuery", "expected an enclosing width feature query");
    const feature = text(query.getChild("FeatureName")!);
    const number = query.getChild("NumberLiteral")!;
    const unit = number.getChild("Unit")!;
    const limit = Number(css.slice(number.from, unit.from));

    assert.equal(text(unit), "px", "these responsive breakpoints use CSS pixels");
    assert.ok(Number.isFinite(limit));
    assert.ok(["min-width", "max-width"].includes(feature), `unexpected constraint: ${feature}`);

    return feature === "min-width" ? width >= limit : width <= limit;
}

function applies(selector: string, property: string, width: number, value?: string) {
    const candidates = rules.filter(
        (rule) =>
            rule.selectors.includes(selector) &&
            rule.declarations.has(property) &&
            (value === undefined || rule.declarations.get(property) === value),
    );

    assert.ok(candidates.length > 0, `${selector} needs its ${property} policy`);

    return candidates.some((rule) =>
        rule.media.every((media) => {
            const query = media.getChild("BinaryQuery") ?? media.getChild("FeatureQuery");

            assert.ok(query, "expected a width query for the main layout policy");

            return widthQuery(query, width);
        }),
    );
}

for (const [width, docked] of [
    [390, false],
    [767, false],
    [768, true],
    [820, true],
    [834, true],
    [959, true],
    [960, true],
    [1280, true],
] as const) {
    test(`${width}px: main tiling and docked sidebar share the responsive range`, () => {
        assert.deepEqual(
            {
                dockedSidebar: applies(sidebar, "display", width, "flex"),
                layoutGap: applies(layout, "gap", width),
                layoutPadding: applies(layout, "padding", width),
                windowFrame: applies(frame, "border", width),
                focusBorder: applies(focus, "border-color", width),
                focusRing: applies(focus, "box-shadow", width),
            },
            {
                dockedSidebar: docked,
                layoutGap: docked,
                layoutPadding: docked,
                windowFrame: docked,
                focusBorder: docked,
                focusRing: docked,
            },
        );
    });
}
