// Offline CSS contracts for controller activity, not screenshot/geometry or frame-timing proof.
// SessionList tests own placement, owner access and the controller/execution distinction.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { cssLanguage } from "@codemirror/lang-css";

const css = readFileSync(new URL("../web/style.css", import.meta.url), "utf8");
const tree = cssLanguage.parser.parse(css);

type CSSNode = typeof tree.topNode;
type Declaration = { value: string; node: CSSNode };
type Rule = { selectors: string[]; media: string[]; declarations: Map<string, Declaration> };
const rules: Rule[] = [];
const keyframes = new Map<string, { offset: number; color: string }[]>();
const compact = (value: string) => value.replace(/\s+/g, "");
const selectorKey = (value: string) => value.replace(/["']/g, "").replace(/\s+/g, " ").trim();

function declarations(block: CSSNode) {
    return new Map(
        block.getChildren("Declaration").map((node) => {
            const name = node.getChild("PropertyName")!;

            return [
                css.slice(name.from, name.to),
                {
                    value: css
                        .slice(name.to, node.to)
                        .replace(/^\s*:\s*/, "")
                        .trim(),
                    node,
                },
            ];
        }),
    );
}

tree.iterate({
    enter(node) {
        if (node.name === "RuleSet") {
            const block = node.node.getChild("Block")!;
            const selectors: string[] = [];
            const media: string[] = [];

            for (
                let child = node.node.firstChild;
                child && child.name !== "Block";
                child = child.nextSibling
            ) {
                if (child.name !== ",") {
                    selectors.push(selectorKey(css.slice(child.from, child.to)));
                }
            }

            if (!selectors.some((selector) => selector.includes(".work-item-pip-state"))) {
                return;
            }

            for (let parent = node.node.parent; parent; parent = parent.parent) {
                if (parent.name === "MediaStatement") {
                    const block = parent.getChild("Block")!;

                    media.push(compact(css.slice(parent.from, block.from)));
                }
            }

            rules.push({ selectors, media, declarations: declarations(block) });
        }

        if (node.name === "KeyframesStatement") {
            const name = node.node.getChild("KeyframeName")!;
            const frames = node.node.getChild("KeyframeList")!;
            const stops: { offset: number; color: string }[] = [];
            let offsets: number[] = [];

            for (let child = frames.firstChild; child; child = child.nextSibling) {
                if (child.name === "KeyframeSelector") {
                    const value = css.slice(child.from, child.to).trim();

                    offsets.push(
                        value === "from" ? 0 : value === "to" ? 1 : parseFloat(value) / 100,
                    );
                } else if (child.name === "Block") {
                    const color = declarations(child).get("color");

                    if (color) {
                        stops.push(
                            ...offsets.map((offset) => ({ offset, color: compact(color.value) })),
                        );
                    }

                    offsets = [];
                }
            }

            keyframes.set(
                css.slice(name.from, name.to),
                stops.sort((a, b) => a.offset - b.offset),
            );
        }
    },
});

function declaration(selector: string, property: string, media?: string) {
    const matches = rules.filter(
        (rule) =>
            rule.selectors.includes(selectorKey(selector)) &&
            (media === undefined
                ? rule.media.length === 0
                : rule.media.some((scope) => scope.includes(compact(media)))),
    );

    return matches.reduce<Declaration | undefined>(
        (current, rule) => rule.declarations.get(property) ?? current,
        undefined,
    );
}

const primary = ".work-item-pip-state";
const active = '.work-item-pip-state[data-status="running"]';

test("inactive controller dials are static muted gray while active dials start with the accent", () => {
    assert.equal(declaration(primary, "color")?.value, "var(--muted)");
    const animation = declaration(primary, "animation")?.value;

    assert.ok(animation === undefined || animation === "none", "base dials must not pulse");
    assert.equal(declaration(active, "color")?.value, "var(--accent)");
});

test("only running controller dials step through the ordered working palette and reuse the pulse", () => {
    const animation = declaration(active, "animation");

    assert.ok(animation, "running dials need palette motion and a pulse");
    const segments: CSSNode[][] = [[]];

    for (let child = animation.node.firstChild; child; child = child.nextSibling) {
        if (child.name === ",") {
            segments.push([]);
        } else if (child.name !== "PropertyName" && child.name !== ":") {
            segments.at(-1)!.push(child);
        }
    }

    const motions = segments.map((segment) => ({
        names: segment
            .filter((node) => node.name === "ValueName")
            .map((node) => css.slice(node.from, node.to)),
        value: compact(segment.map((node) => css.slice(node.from, node.to)).join(" ")),
    }));
    const pulse = motions.find((motion) => motion.names.includes("pulse"));
    const colors = motions.find((motion) =>
        motion.names.some((name) => keyframes.has(name) && name !== "pulse"),
    );

    assert.ok(pulse?.names.includes("infinite"), "active dials reuse the continuous native pulse");
    assert.ok(colors, "running dials need an ordered working-palette animation");
    assert.ok(colors.names.includes("infinite"), "the working palette repeats while active");
    assert.ok(
        colors.value.includes("steps(1,end)"),
        "palette colors step instead of interpolating",
    );
    const name = colors.names.find((name) => keyframes.has(name) && name !== "pulse")!;
    const stops = keyframes.get(name)!;
    const palette = stops
        .filter((stop) => !(stop.offset === 1 && stop.color === stops[0]?.color))
        .map((stop) => stop.color);

    assert.deepEqual(palette, [
        "var(--accent)",
        "color-mix(inoklab,var(--accent)67%,var(--spark))",
        "color-mix(inoklab,var(--accent)33%,var(--spark))",
        "var(--spark)",
    ]);
});

for (const [selector, media] of [
    [':root[data-motion="reduced"] .work-item-pip-state', undefined],
    [':root:not([data-motion="full"]) .work-item-pip-state', "prefers-reduced-motion: reduce"],
] as const) {
    test(`${media ?? "explicit app reduced motion"} makes the controller dial static`, () => {
        assert.equal(
            compact(declaration(selector, "animation", media)?.value ?? ""),
            "none!important",
            "both palette and pulse must stop, while the OS preference still permits the app's Full override",
        );
    });
}
