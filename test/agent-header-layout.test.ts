// Offline responsive CSS contracts, not computed geometry or device proof. Component interaction,
// dismissal and exact navigation are owned by agent-tabs-ui. No synthetic width-budget simulator.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { cssLanguage } from "@codemirror/lang-css";

const css = readFileSync(new URL("../web/named-agents.css", import.meta.url), "utf8");
const tree = cssLanguage.parser.parse(css);
const rules: { selectors: string[]; media: string[]; declarations: Map<string, string> }[] = [];

tree.iterate({
    enter(node) {
        assert.equal(node.type.isError, false, `CSS syntax at ${node.from}`);

        if (node.name !== "RuleSet") {
            return;
        }

        const block = node.node.getChild("Block")!;
        const declarations = new Map<string, string>();
        const media: string[] = [];

        for (let parent = node.node.parent; parent; parent = parent.parent) {
            const block = parent.getChild("Block");
            const prelude = block === null ? "" : css.slice(parent.from, block.from).trim();

            // This CSS grammar parses container queries as generic at-rules.
            if (
                parent.name === "MediaStatement" ||
                parent.name === "ContainerStatement" ||
                (parent.name === "AtRule" && /^@container\s/.test(prelude))
            ) {
                media.push(prelude);
            }
        }

        for (const declaration of block.getChildren("Declaration")) {
            const name = declaration.getChild("PropertyName")!;

            declarations.set(
                css.slice(name.from, name.to),
                css
                    .slice(name.to, declaration.to)
                    .replace(/^\s*:\s*/, "")
                    .trim(),
            );
        }

        rules.push({
            selectors: css
                .slice(node.from, block.from)
                .trim()
                .split(/,\s*(?![^()]*\))/),
            media,
            declarations,
        });
    },
});

function declaration(selector: string, property: string, scope?: string) {
    const matches = rules.filter(
        (rule) =>
            rule.selectors.includes(selector) &&
            (scope === undefined
                ? rule.media.length === 0
                : rule.media.some((media) => media.includes(scope))),
    );

    assert.ok(matches.length > 0, selector + " needs its responsive rule");

    return matches.reduce<string | undefined>(
        (value, rule) => rule.declarations.get(property) ?? value,
        undefined,
    );
}

test("the PiPs heading uses source-tab typography and selected versus muted colors", () => {
    const heading = ".named-agents-head .named-agents-toggle";

    assert.equal(declaration(heading, "font-size"), "12.5px");
    assert.equal(declaration(heading, "font-weight"), "500");
    assert.equal(declaration(heading, "color"), "var(--muted)");
    assert.equal(declaration(".named-agents-head.on .named-agents-toggle", "color"), "var(--text)");
    assert.equal(declaration(".named-agent-status .spinner", "display"), "block");
});

test("phones use a bounded compact chooser while only the wider chat rail scrolls", () => {
    assert.equal(declaration(".topbar.agent-topbar", "flex-wrap"), "nowrap");
    assert.notEqual(declaration(".topbar.agent-topbar", "overflow-x"), "auto");
    assert.equal(declaration(".agent-tabs", "min-width"), "0");
    assert.equal(declaration(".agent-tabs-strip", "display"), "none");
    assert.equal(declaration(".agent-chat-switch", "display"), "flex");
    assert.equal(declaration(".agent-tabs-strip", "overflow-x"), "auto");
    assert.equal(declaration(".agent-tabs-strip", "overscroll-behavior-x"), "contain");
    assert.equal(declaration(".agent-tab-new", "flex"), "none");
    assert.equal(declaration(".agent-header-context", "display"), "none");
});

test("tablet panes regain tabs and agent context without restoring ordinary tools", () => {
    assert.equal(declaration(".agent-tabs-strip", "display", "min-width: 430px"), "flex");
    assert.equal(declaration(".agent-chat-switch", "display", "min-width: 430px"), "none");
    const tabs = rules.find(
        (rule) =>
            rule.selectors.includes(".agent-tabs-strip") &&
            rule.declarations.get("display") === "flex",
    );

    assert.ok(tabs?.media.includes("@media (min-width: 700px)"));

    assert.equal(declaration(".agent-header-context", "display", "min-width: 880px"), "flex");
});

test("local chrome retains coarse-pointer targets, native scroll, press feedback and keyboard focus", () => {
    const coarse = "any-pointer: coarse";

    assert.equal(declaration(".agent-topbar button", "min-height", coarse), "44px");
    assert.equal(declaration(".agent-tab-close", "min-width", coarse), "44px");
    assert.equal(declaration(".agent-tab-new", "min-width", coarse), "44px");
    assert.equal(declaration(".agent-chat-choices :is(a, button)", "min-height"), "44px");
    assert.equal(declaration(".agent-topbar :is(a, button)", "touch-action"), "manipulation");
    assert.equal(declaration(".agent-topbar :is(a, button)", "user-select"), "none");
    assert.equal(declaration(".named-agents-head.on", "box-shadow"), "inset 0 -2px var(--accent)");
    assert.equal(declaration(".named-agent-open", "width"), "100%");
    assert.equal(
        declaration(".agent-history-list :is(a, button)", "-webkit-touch-callout"),
        "none",
    );
    assert.equal(
        declaration(".agent-topbar :is(a, button):active", "background"),
        "var(--pressed)",
    );
    assert.equal(
        declaration(".agent-chat-choices :is(a, button):focus-visible", "outline"),
        "2px solid var(--accent)",
    );

    for (const rule of rules.filter((rule) =>
        rule.selectors.some((selector) => selector.includes(":hover")),
    )) {
        assert.ok(rule.media.includes("@media (hover: hover) and (pointer: fine)"));
    }
});
