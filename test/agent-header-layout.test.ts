// Offline CSS contract, not computed geometry/device proof. The production CSS is parsed, not copied
// into a layout simulator. This is the cheapest available guard for the phone-only overflow repair;
// component checks in agent-tabs-ui own selection/reveal, native actions and retained tab behavior.
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
            if (parent.name === "MediaStatement" || parent.name === "ContainerStatement") {
                media.push(css.slice(parent.from, parent.getChild("Block")!.from).trim());
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

function phone(selector: string, property: string) {
    const found = rules.filter(
        (rule) =>
            rule.selectors.includes(selector) && rule.media.includes("@media (max-width: 699px)"),
    );

    assert.ok(found.length > 0, `${selector} needs a phone-only rule`);

    return found.reduce<string | undefined>(
        (value, rule) => rule.declarations.get(property) ?? value,
        undefined,
    );
}

test("phone headers scroll as one row instead of letting fixed tools and 40% context squeeze the tabs", () => {
    assert.equal(phone(".topbar.agent-topbar", "overflow-x"), "auto");
    assert.equal(phone(".topbar.agent-topbar", "flex-wrap"), "nowrap");
    assert.equal(phone(".topbar.agent-topbar", "scroll-padding-inline"), "52px 72px");
    assert.equal(phone(".agent-topbar > *", "flex-shrink"), "0");
    assert.equal(phone(".topbar > .title.title-agent", "flex"), "none");
    assert.equal(phone(".topbar > .title.title-agent", "margin-left"), "0");
    assert.equal(phone(".title-agent > .title-sub", "flex"), "none");
    assert.equal(phone(".title-agent > .title-sub", "max-width"), "none");
    assert.equal(phone(".title-agent > .agent-tabs", "max-width"), "none");
    assert.equal(phone(".agent-tabs-strip", "overflow-x"), "visible");
    assert.equal(phone(".agent-tab-item", "width"), "160px");
    assert.equal(phone(".agent-tab-close", "width"), "44px");
    assert.equal(phone(".agent-tab-new", "width"), "44px");
    assert.equal(phone(".agent-tabs :is(a, button)", "min-height"), "44px");
});

test("authored 320/360/390/430px width budgets fit the full selected tab between the sticky caps", () => {
    const tab = Number.parseFloat(phone(".agent-tab-item", "width")!);
    const close = Number.parseFloat(phone(".agent-tab-close", "width")!);
    const [leading, trailing] = phone(".topbar.agent-topbar", "scroll-padding-inline")!
        .split(" ")
        .map(Number.parseFloat);

    assert.ok(leading !== undefined && trailing !== undefined);

    for (const width of [320, 360, 390, 430]) {
        assert.ok(tab <= width - leading - trailing, `${width}px must fit a whole selected tab`);
    }

    assert.ok(
        close >= 44 && tab - close >= 44,
        "Close and the chat link each retain a touch target",
    );
});

test("phone Back/Menu remain pinned, tools stay reachable and a swipe cue is limited to the phone header", () => {
    assert.equal(phone(".agent-topbar > .topbar-back", "position"), "sticky");
    assert.equal(phone(".agent-topbar > .topbar-back", "left"), "4px");
    assert.equal(phone(".agent-topbar > .topbar-menu", "position"), "sticky");
    assert.equal(phone(".agent-topbar > .topbar-menu", "right"), "6px");
    assert.equal(phone(".topbar.agent-topbar > .icon-button", "min-width"), "44px");
    assert.equal(phone(".topbar.agent-topbar > .icon-button", "min-height"), "44px");

    for (const control of [".top-toggle", ".people-button", ".quiet-phone"]) {
        assert.equal(phone(`.topbar.agent-topbar ${control}`, "display"), "inline-flex");
    }

    assert.equal(phone(".agent-header-scroll-hint", "display"), "flex");
    assert.ok(
        rules.some(
            (rule) =>
                rule.selectors.includes(".agent-header-scroll-hint") &&
                rule.media.length === 0 &&
                rule.declarations.get("display") === "none",
        ),
        "desktop keeps its incumbent controls without a swipe cue",
    );
});
