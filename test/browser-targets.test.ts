// Authoring gate: exercise the actual page scripts and BrowserPage.locate with synthetic controls.
// Protects password-safe target descriptions, coverage/visibility errors and value-based matching.
// CDP/DOM geometry are stand-ins; this is not Chromium, layout or real credential evidence.
import assert from "node:assert/strict";
import { registerHooks } from "node:module";
import { test } from "node:test";
import { runInNewContext } from "node:vm";
import { LOCATE_SCRIPT } from "../src/server/browser/page-scripts.ts";

// No network reader is needed for locating a target. Keep this suite dependency-free/offline.
const readerStub = `
    export const readPublicDocument = () => { throw new Error("Unexpected network read"); };
`;
const loader = registerHooks({
    resolve(specifier, context, next) {
        return context.parentURL?.endsWith("/browser/page.ts") && specifier === "../public-read.ts"
            ? {
                  url: `data:text/javascript,${encodeURIComponent(readerStub)}`,
                  shortCircuit: true,
              }
            : next(specifier, context);
    },
});
const { BrowserPage } = await import("../src/server/browser/page.ts");

loader.deregister();

const SECRET = "synthetic-password-not-a-credential";

function input(type = "password", attrs: Record<string, string> = {}) {
    return {
        tagName: "INPUT",
        type,
        id: "field",
        value: type === "password" ? SECRET : "Normal value",
        innerText: "",
        children: [],
        isConnected: true,
        getAttribute: (name: string) => attrs[name] ?? null,
        getClientRects: () => [{}],
        getBoundingClientRect: () => ({ left: 10, top: 20, width: 100, height: 40 }),
        scrollIntoView() {},
        contains: () => false,
    };
}

function pageFixture() {
    const field = input();
    const button = { ...input("button"), tagName: "BUTTON", id: "go", innerText: "Continue" };
    const hit = field;
    const context = {
        window: { __piPocketRefs: new Map([["e1", new WeakRef(field)]]) },
        document: {
            querySelector: () => field,
            querySelectorAll: () => [field],
            body: { querySelectorAll: () => [field] },
            elementFromPoint: () => hit,
        },
        getComputedStyle: () => ({ visibility: "visible" }),
        requestAnimationFrame: (done: () => void) => done(),
    };
    const locate = (target: unknown) =>
        runInNewContext(`(${LOCATE_SCRIPT})(${JSON.stringify(target)})`, context);

    return { field, button, context, locate };
}

test("password target descriptions and visibility/coverage errors never use the field value", async () => {
    const fixture = pageFixture();

    for (const target of [{ ref: "e1" }, { selector: "#field" }]) {
        const found = await fixture.locate(target);

        assert.equal(found.label, "input#field");
        assert.ok(!JSON.stringify(found).includes(SECRET));
    }

    fixture.field.getAttribute = (name) => (name === "placeholder" ? "Account password" : null);
    assert.equal(
        (await fixture.locate({ label: "Account password" })).label,
        'input#field "Account password"',
    );
    fixture.field.getBoundingClientRect = () => ({ left: 10, top: 20, width: 0, height: 0 });
    await assert.rejects(fixture.locate({ ref: "e1" }), (error: Error) => {
        assert.match(error.message, /Account password.*not visible/);
        assert.ok(!error.message.includes(SECRET));

        return true;
    });
    fixture.field.getBoundingClientRect = () => ({ left: 10, top: 20, width: 100, height: 40 });
    fixture.context.document.querySelector = () => fixture.button;
    const covered = await fixture.locate({ selector: "#go" });

    assert.equal(covered.covered, 'input#field "Account password"');
    assert.ok(!JSON.stringify(covered).includes(SECRET));
});

test("password values cannot locate a control; public labels and ordinary values still can", async () => {
    const fixture = pageFixture();

    await assert.rejects(fixture.locate({ label: SECRET }), /Nothing on the page says/);
    fixture.context.document.querySelectorAll = () => [];
    await assert.rejects(fixture.locate({ label: SECRET }), /Nothing on the page says/);
    fixture.context.document.querySelectorAll = () => [fixture.field];
    fixture.field.getAttribute = (name) => (name === "aria-label" ? "Password" : null);
    assert.equal((await fixture.locate({ label: "Password" })).label, 'input#field "Password"');
    fixture.field.type = "text";
    fixture.field.getAttribute = () => null;
    fixture.field.value = "Normal value";
    assert.equal(
        (await fixture.locate({ label: "Normal value" })).label,
        'input#field "Normal value"',
    );
});

test("the actual coordinate path returns a point, without evaluating or describing the password field", async () => {
    const page = new BrowserPage({
        conversationId: 1,
        connection: {
            listen() {},
            send() {
                throw new Error("Coordinates must not read page values");
            },
        } as never,
        session: "synthetic",
        target: "synthetic",
        context: undefined,
        userAgent: "",
        viewport: { width: 1280, height: 800, scale: 1, mobile: false },
        changed() {},
        saved() {},
    });

    assert.deepEqual(await page.locate({ x: 60, y: 40 }), {
        x: 60,
        y: 40,
        label: "the point 60,40",
    });
});
