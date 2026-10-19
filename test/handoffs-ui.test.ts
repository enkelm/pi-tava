// Browser owner: nonblocking two-step picker, optional slash completion, real input acceptance, clarification, tool-result
// navigation/reload and indivisible Work Item controls. Backend tests own deterministic routing,
// input provenance and durable creation. Transport faults never fabricate handoff receipts.
// All Git repositories, app data and browser profiles are disposable. Run only where listeners,
// Chromium and the workflow Git sandbox are available; no production test seams or live data.
import { cleanUp, lastText, openApp, owner, root, scriptedModel, until, work } from "./helpers.ts";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import { join } from "node:path";
import { after, test } from "node:test";
import type { ConversationId } from "@earendil-works/pi-durable";
import { fauxAssistantMessage, fauxToolCall } from "@earendil-works/pi-ai/providers/faux";
import { Browsers } from "../src/server/browser.ts";
import { findBrowser } from "../src/server/browser/discovery.ts";
import type { BrowserPage } from "../src/server/browser/page.ts";
import { VIEWPORTS } from "../src/server/browser/viewport.ts";
import { createHandler } from "../src/server/http.ts";
import { TITLE_PROMPT } from "../src/server/titles.ts";

after(cleanUp);

async function value<T>(page: BrowserPage, expression: string): Promise<T> {
    return JSON.parse(await page.evaluate(`return JSON.stringify(${expression})`)) as T;
}

async function present(page: BrowserPage, selector: string, expected = true) {
    await until(
        () =>
            value<boolean>(
                page,
                `[...document.querySelectorAll(${JSON.stringify(selector)})].some(element => {
            const box = element.getBoundingClientRect();

            return box.width > 0 && box.height > 0 && !element.closest('[inert]');
        }) === ${expected}`,
            ),
        `${expected ? "show" : "hide"} ${selector}`,
        20_000,
    );
}

async function click(page: BrowserPage, selector: string) {
    await present(page, selector);
    await page.evaluate(`[...document.querySelectorAll(${JSON.stringify(selector)})].find(element => {
        const box = element.getBoundingClientRect();

        return box.width > 0 && box.height > 0 && !element.closest('[inert]');
    }).click()`);
}

async function button(page: BrowserPage, scope: string, text: string) {
    const expression = `[...document.querySelectorAll(${JSON.stringify(`${scope} button`)})].find(element => (element.textContent.trim() === ${JSON.stringify(text)} || element.querySelector(':scope > span')?.textContent.trim() === ${JSON.stringify(text)}) && element.getBoundingClientRect().width > 0)`;

    await until(() => value<boolean>(page, `Boolean(${expression})`), `button ${text}`);
    await page.evaluate(`(${expression}).click()`);
}

async function fill(page: BrowserPage, selector: string, text: string) {
    await present(page, selector);
    await page.evaluate(`const field = document.querySelector(${JSON.stringify(selector)});
        field.focus();
        field.value = ${JSON.stringify(text)};
        field.setSelectionRange(field.value.length, field.value.length);
        field.dispatchEvent(new InputEvent('input', { bubbles: true }));`);
}

async function shot(page: BrowserPage, name: string) {
    const directory = process.env.HANDOFFS_SCREENSHOT_DIR;

    if (directory === undefined) {
        return;
    }

    mkdirSync(directory, { recursive: true });
    const captured = await page.screenshot();

    writeFileSync(join(directory, `${name}.jpg`), Buffer.from(captured.data, "base64"));
}

const composer = 'textarea[aria-label="Message Pi"]';
const commandRows = '.composer .commands [role="option"]';
const optionsSurface = ":is(.sidebar-options-menu, .sidebar-options-sheet)";
const draft = (page: BrowserPage) =>
    value<string>(page, `document.querySelector(${JSON.stringify(composer)}).value`);

async function commandNames(page: BrowserPage) {
    const names = `[...document.querySelectorAll(${JSON.stringify(`${commandRows}.command .command-name`)})].map(row => row.textContent.trim()).filter(name => name !== '/handoff')`;

    await until(
        () => value<boolean>(page, `(${names}).length > 0`),
        "handoff argument completions load, not the loading or error status row",
    );

    return value<string[]>(page, names);
}

async function pickCommand(page: BrowserPage, text: string) {
    const expression = `[...document.querySelectorAll(${JSON.stringify(commandRows)})].find(row => row.querySelector('.command-name')?.textContent.trim() === ${JSON.stringify(text)})`;

    await until(() => value<boolean>(page, `Boolean(${expression})`), `completion ${text}`);
    await page.evaluate(`(${expression}).click()`);
}

async function rowOptions(page: BrowserPage, row: string, viewport: "desktop" | "mobile") {
    if (viewport === "mobile") {
        await present(page, `${row} .session`);
        await page.evaluate(`
            await Promise.all(document.getAnimations()
                .filter(animation => animation.effect?.getComputedTiming().endTime !== Infinity)
                .map(animation => animation.finished.catch(() => {})));
            const target = document.querySelector(${JSON.stringify(`${row} .session`)});

            target.scrollIntoView({ block: 'nearest', behavior: 'instant' });
            await new Promise(requestAnimationFrame);
            await new Promise(requestAnimationFrame);
            const rect = target.getBoundingClientRect();
            const point = { x: rect.left + rect.width / 2, y: rect.top + rect.height / 2 };

            window.handoffOptionsFinger = { target, point };
            const touch = new Touch({ identifier: 71, target, clientX: point.x, clientY: point.y });

            target.dispatchEvent(new TouchEvent('touchstart', {
                bubbles: true, cancelable: true, touches: [touch], changedTouches: [touch],
            }));
        `);
        await present(page, `${row} .session-hold`);
        await page.evaluate(`
            const { target, point } = window.handoffOptionsFinger;
            const touch = new Touch({ identifier: 71, target, clientX: point.x + 16, clientY: point.y });

            target.dispatchEvent(new TouchEvent('touchmove', {
                bubbles: true, cancelable: true, touches: [touch], changedTouches: [touch],
            }));
        `);
        await present(page, optionsSurface);
        await page.evaluate(`
            const { target, point } = window.handoffOptionsFinger;
            const touch = new Touch({ identifier: 71, target, clientX: point.x + 16, clientY: point.y });

            target.dispatchEvent(new TouchEvent('touchend', {
                bubbles: true, cancelable: true, touches: [], changedTouches: [touch],
            }));
            delete window.handoffOptionsFinger;
        `);
    } else {
        await page.evaluate(`document.querySelector(${JSON.stringify(`${row} .session`)}).focus()`);
        await page.press("Shift+F10");
    }

    await present(page, optionsSurface);
}

function gate() {
    let release = () => {};

    const promise = new Promise<void>((resolve) => {
        release = resolve;
    });

    return { promise, release };
}

test(
    "Handoffs UI: shared blocking warnings appear once without changing option eligibility",
    { skip: findBrowser() === undefined ? "no Chromium installed" : false, timeout: 60_000 },
    async () => {
        const app = await openApp(scriptedModel(), join(root, "handoff-warning-data"));
        const source = await app.commands.createSession(owner(app), {
            cwd: work,
            threadType: "worker",
        });
        const server = createServer(
            createHandler({
                app,
                listen: { host: "127.0.0.1", port: 0 },
                restart: () => {},
            }),
        );
        const browsers = new Browsers({
            dataDir: join(root, "handoff-warning-browser"),
            load: async () => undefined,
            save: () => {},
        });
        const sharedReason =
            "Wait until all thread work, including delegated helpers and queued reports, is idle before an exclusive workflow operation (handoff or fetch). End the current turn to receive pending reports; do not retry unchanged attempts.";
        const distinctReason = "This destination has a separate blocking reason.";
        const blocked = [
            {
                targetType: "researcher",
                relationship: "same-work",
                enabled: false,
                reason: sharedReason,
            },
            { targetType: "pull", relationship: "same-work", enabled: false, reason: sharedReason },
            {
                targetType: "worker",
                relationship: "new-work",
                enabled: false,
                reason: sharedReason,
            },
        ];
        const mixed = [
            ...blocked,
            {
                targetType: "researcher",
                relationship: "new-work",
                enabled: false,
                reason: distinctReason,
            },
            { targetType: "pull", relationship: "new-work", enabled: true },
        ];
        const dialog = '[role="dialog"]:has(.handoff-picker)';

        try {
            await new Promise<void>((resolve, reject) => {
                server.once("error", reject);
                server.listen(0, "127.0.0.1", resolve);
            });
            const base = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
            const page = await browsers.open(1);

            await page.navigate(`${base}/login?token=${encodeURIComponent(app.config.ownerToken)}`);
            await page.navigate(`${base}/s/${source.id}`);
            await present(page, ".topbar .handoff-button");
            // Fixture only the eligibility response, not the sheet or its disabled behavior.
            // The authenticated app loads and renders the actual extension in Chromium.
            await page.evaluate(`const fetchOriginal = window.fetch.bind(window);
                window.fetch = (url, options) => {
                    if (/\\/api\\/c\\/\\d+\\/x\\/work-items\\/handoffs$/.test(String(url))) {
                        return Promise.resolve(new Response(JSON.stringify({
                            workflow: {}, options: window.warningOptions,
                        }), { headers: { 'Content-Type': 'application/json' } }));
                    }

                    return fetchOriginal(url, options);
                };`);

            for (const viewport of ["desktop", "mobile"] as const) {
                await page.setViewport(VIEWPORTS[viewport]);

                for (const options of [blocked, mixed]) {
                    await page.evaluate(`window.warningOptions = ${JSON.stringify(options)};
                        for (const key of Object.keys(sessionStorage)) {
                            if (key.startsWith('pocket.handoffDraft.')) {
                                sessionStorage.removeItem(key);
                            }
                        }`);
                    await click(page, ".topbar .handoff-button");
                    await present(page, `${dialog} input[type="radio"]`);
                    const rendered = await value<{
                        occurrences: number;
                        warningBeforeGroups: boolean;
                        inlineReasons: string[];
                        disabled: boolean[];
                        described: string[];
                    }>(
                        page,
                        `(() => {
                        const form = document.querySelector(${JSON.stringify(`${dialog} form`)});
                        const warning = form.querySelector('[role="status"]');
                        const inputs = [...form.querySelectorAll('input[type="radio"]')];

                        return {
                            occurrences: form.textContent.split(${JSON.stringify(sharedReason)}).length - 1,
                            warningBeforeGroups: Boolean(warning && (warning.compareDocumentPosition(form.querySelector('fieldset')) & Node.DOCUMENT_POSITION_FOLLOWING)),
                            inlineReasons: [...form.querySelectorAll('.handoff-option-copy .small')].map(element => element.textContent),
                            disabled: inputs.map(input => input.disabled),
                            described: inputs.map(input => document.getElementById(input.getAttribute('aria-describedby'))?.textContent ?? ''),
                        };
                    })()`,
                    );

                    assert.equal(
                        rendered.occurrences,
                        1,
                        "a repeated blocking reason is shown once",
                    );
                    assert.equal(
                        rendered.warningBeforeGroups,
                        true,
                        "the warning precedes both option groups",
                    );
                    assert.deepEqual(
                        rendered.disabled,
                        options.map((option) => !option.enabled),
                    );
                    assert.deepEqual(
                        rendered.inlineReasons,
                        options === mixed ? [distinctReason] : [],
                    );
                    assert.deepEqual(
                        rendered.described,
                        options.map((_, index) => (index < blocked.length ? sharedReason : "")),
                    );
                    await click(page, `${dialog} input[value="researcher:same-work"]`);
                    assert.equal(
                        await value(
                            page,
                            `document.querySelectorAll(${JSON.stringify(`${dialog} input:checked`)}).length`,
                        ),
                        0,
                    );

                    if (options === mixed) {
                        await click(page, `${dialog} input[value="pull:new-work"]`);
                        await present(page, `${dialog} input[value="pull:new-work"]:checked`);
                        assert.equal(
                            await value(
                                page,
                                `document.querySelector(${JSON.stringify(`${dialog} button[type="submit"]`)}).disabled`,
                            ),
                            false,
                        );
                    } else {
                        assert.equal(
                            await value(
                                page,
                                `document.querySelector(${JSON.stringify(`${dialog} button[type="submit"]`)}).disabled`,
                            ),
                            true,
                        );
                    }

                    assert.equal(
                        await value(page, "document.documentElement.scrollWidth <= innerWidth"),
                        true,
                    );
                    await shot(
                        page,
                        `${viewport}-handoff-${options === mixed ? "mixed" : "shared"}-warning`,
                    );
                    await page.press("Escape");
                    await present(page, dialog, false);
                }
            }
        } finally {
            await browsers.closeAll({ final: true });
            await app.close();
            server.closeAllConnections();

            if (server.listening) {
                await new Promise<void>((resolve) => server.close(() => resolve()));
            }
        }
    },
);

test(
    "Handoffs UI: real slash/English input, clarification, tool-result reload and whole Work Items",
    { skip: findBrowser() === undefined ? "no Chromium installed" : false, timeout: 180_000 },
    async (t) => {
        for (const viewport of ["desktop", "mobile"] as const) {
            await t.test(viewport, async () => {
                const cwd = join(work, `handoff-${viewport}`);

                mkdirSync(cwd);
                writeFileSync(join(cwd, "fixture.txt"), "Disposable handoff checkout\n");
                execFileSync("git", ["init", cwd]);
                execFileSync("git", ["-C", cwd, "add", "fixture.txt"]);
                execFileSync("git", [
                    "-C",
                    cwd,
                    "-c",
                    "user.name=Fixture",
                    "-c",
                    "user.email=fixture@example.test",
                    "commit",
                    "-m",
                    "fixture",
                ]);

                let replyGate: ReturnType<typeof gate> | undefined;
                let summaryGate: ReturnType<typeof gate> | undefined;
                let titleRequests = 0;
                const handoffInputs: string[] = [];
                const userInputs: string[] = [];
                const holdMessage = "Hold this reply while I inspect handoff choices.";
                const receivedSummary =
                    "Original ask: repair durable retry delivery. Files: handoffs.ts. Tests: fixture lifecycle passed. Deferred: hardware browser checks. Limits: no commit, push or restart.";
                const namedTitle = "Durable retry delivery";
                const model = scriptedModel(async (request, options) => {
                    const last = lastText(request as never);

                    if (last.role === "user" && last.text.startsWith(TITLE_PROMPT)) {
                        titleRequests++;
                        assert.ok(last.text.includes(receivedSummary));

                        return fauxAssistantMessage(namedTitle);
                    }

                    if (last.role === "user") {
                        userInputs.push(last.text);
                    }

                    const humanText = last.text.replace(/^\[from:[^\]]+\]\s*/, "");
                    const handoff =
                        last.role === "user" &&
                        (humanText.startsWith("/handoff reviewer") ||
                            humanText.startsWith("/handoff researcher") ||
                            humanText.startsWith("Please hand off to a new worker."));

                    if (handoff) {
                        handoffInputs.push(last.text);
                    }

                    if (last.role === "user" && humanText.trim() === "/handoff") {
                        return fauxAssistantMessage("Which role and scope should take over?");
                    }

                    const held = handoff
                        ? summaryGate
                        : last.text.includes(holdMessage)
                          ? replyGate
                          : undefined;

                    if (held !== undefined) {
                        await Promise.race([
                            held.promise,
                            new Promise<void>((resolve) =>
                                options?.signal?.addEventListener("abort", () => resolve(), {
                                    once: true,
                                }),
                            ),
                        ]);
                    }

                    if (handoff) {
                        return fauxAssistantMessage(
                            [
                                fauxToolCall("handoff", {
                                    action: "start",
                                    targetType: humanText.startsWith("/handoff reviewer")
                                        ? "reviewer"
                                        : humanText.startsWith("/handoff researcher")
                                          ? "researcher"
                                          : "worker",
                                    relationship: humanText.startsWith("/handoff")
                                        ? "same-work"
                                        : "new-work",
                                    summary: receivedSummary,
                                }),
                            ],
                            { stopReason: "toolUse" },
                        );
                    }

                    return fauxAssistantMessage(
                        "Fixture work complete. No external action performed.",
                    );
                });
                const app = await openApp(model, join(root, `handoff-${viewport}-data`));
                const user = owner(app);
                const project = await app.projects.create(user, {
                    name: "Handoff project",
                    cwd,
                    requestId: `project-${viewport}`,
                });
                const origin = await app.commands.createSession(user, {
                    cwd,
                    threadType: "worker",
                    title: "Build the handoff flow",
                    projectId: project.id,
                });
                const originId = origin.id as ConversationId;

                await app.commands.configure(originId, user, {
                    model: { provider: "faux", modelId: "faux-1" },
                    thinkingLevel: "off",
                });
                const server = createServer(
                    createHandler({
                        app,
                        listen: { host: "127.0.0.1", port: 0 },
                        restart: () => {},
                    }),
                );
                const browsers = new Browsers({
                    dataDir: join(root, `handoff-${viewport}-browser`),
                    load: async () => undefined,
                    save: () => {},
                });

                await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
                const base = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
                const scope = viewport === "mobile" ? ".home-list .sessions" : ".sidebar .sessions";

                const home = async (page: BrowserPage) => {
                    if (viewport === "mobile") {
                        await click(page, '[aria-label^="Back to sessions"]');
                    }
                };

                try {
                    const page = await browsers.open(1);

                    await page.setViewport(VIEWPORTS[viewport]);
                    await page.navigate(
                        `${base}/login?token=${encodeURIComponent(app.config.ownerToken)}`,
                    );
                    await click(page, `${scope} .session-row[data-id="${origin.id}"] .session`);
                    await present(page, ".topbar .handoff-button");
                    await present(page, '[role="dialog"][aria-label="Choose next thread"]', false);

                    // Intercept transport failures only. Model/tool execution and all receipts
                    // still come from the real authenticated app, never a mocked handoff result.
                    await page.evaluate(`const fetchOriginal = window.fetch.bind(window);
                        window.handoffRequests = [];
                        window.acceptedHandoffInputs = [];
                        window.legacyHandoffPosts = 0;
                        window.handoffRejectNext = false;
                        window.handoffRejectLookup = false;
                        window.fetch = async (url, options) => {
                            const address = String(url);
                            const submitted = /\\/api\\/c\\/\\d+\\/submit$/.test(address) && options?.method === 'POST';
                            const body = submitted ? JSON.parse(options.body) : null;
                            const handoff = body && /^\\/handoff(?:\\s|$)/.test(body.text);
                            const lookup = /\\/api\\/c\\/\\d+\\/x\\/work-items\\/handoffs$/.test(address);

                            if (/\\/api\\/c\\/\\d+\\/handoffs$/.test(address) && options?.method === 'POST') {
                                window.legacyHandoffPosts++;
                            }

                            if (lookup && options?.method !== 'POST' && window.handoffRejectLookup) {
                                return new Response(JSON.stringify({ error: 'Fixture lookup disconnected' }), { status: 503 });
                            }

                            if (handoff) {
                                window.handoffRequests.push(body);

                                if (window.handoffRejectNext) {
                                    window.handoffRejectNext = false;

                                    if (window.handoffHoldRejection) {
                                        window.handoffHoldRejection = false;
                                        await new Promise(resolve => { window.releaseHandoffRejection = resolve; });
                                    }

                                    return new Response(JSON.stringify({ error: 'Fixture input rejected' }), { status: 409 });
                                }
                            }

                            const response = await fetchOriginal(url, options);

                            if (handoff && response.ok) {
                                window.acceptedHandoffInputs.push(await response.clone().json());
                            }

                            return response;
                        };`);
                    await fill(page, composer, "/hand");
                    await pickCommand(page, "/handoff");
                    await until(
                        () => draft(page).then((text) => text === "/handoff "),
                        "command fills draft",
                    );
                    const choices = await commandNames(page);

                    assert.ok(choices.includes("/handoff researcher"));
                    assert.ok(choices.includes("/handoff worker --new"));
                    await shot(page, `${viewport}-handoff-arguments`);
                    await fill(page, composer, "/handoff resea");
                    assert.deepEqual(await commandNames(page), [
                        "/handoff researcher",
                        "/handoff researcher --new",
                    ]);

                    if (viewport === "desktop") {
                        await page.press("Enter");
                    } else {
                        await pickCommand(page, "/handoff researcher");
                    }

                    await until(
                        () => draft(page).then((text) => text === "/handoff researcher "),
                        "role completion leaves steering space",
                    );

                    if (viewport === "desktop") {
                        await fill(page, composer, "/handoff researcher");
                        await commandNames(page);
                        await page.press("ArrowDown");
                        await page.press("Enter");
                        assert.equal(
                            await draft(page),
                            "/handoff researcher --new ",
                            "an explicitly highlighted relationship completes instead of sending the exact role",
                        );
                    }

                    await fill(page, composer, "/handoff worker --n");
                    await commandNames(page);
                    await page.press("Tab");
                    assert.equal(await draft(page), "/handoff worker --new ");
                    await fill(page, composer, "/handoff --new resea");
                    await commandNames(page);
                    await page.press("Tab");
                    assert.equal(await draft(page), "/handoff --new researcher ");
                    assert.equal(handoffInputs.length, 0);
                    assert.equal(
                        await value(page, "window.handoffRequests.length"),
                        0,
                        "clicks, Tab and desktop Enter only complete; none submit",
                    );

                    // A real in-flight model reply makes the server's options unavailable. The
                    // autocomplete must display its reason and ignore both pointer and keyboard picks.
                    writeFileSync(join(cwd, "fixture.txt"), "Actual changed file to review\n");
                    replyGate = gate();
                    await fill(page, composer, holdMessage);
                    await click(page, ".composer .send");
                    await until(() => app.isBusy(originId), "ordinary reply is held");
                    await fill(page, composer, "/handoff ");
                    await present(page, `${commandRows}[aria-disabled="true"]`);
                    const unavailable = (await app.workItems.list(originId, user)).options.find(
                        (option) =>
                            option.targetType === "researcher" &&
                            option.relationship === "same-work",
                    )!;

                    assert.ok(unavailable.reason);
                    await until(
                        () =>
                            value<boolean>(
                                page,
                                `[...document.querySelectorAll(${JSON.stringify(commandRows)})].some(row => row.getAttribute('aria-disabled') === 'true' && row.textContent.includes(${JSON.stringify(unavailable.reason)}))`,
                            ),
                        "disabled options display the server's reason after loading",
                    );
                    await pickCommand(page, "/handoff researcher");
                    await page.press("Tab");
                    assert.equal(await draft(page), "/handoff ");
                    assert.equal(await value(page, "window.handoffRequests.length"), 0);
                    replyGate.release();
                    replyGate = undefined;
                    await until(() => !app.isBusy(originId), "ordinary reply settles");

                    await fill(page, composer, "/handoff rev");
                    await present(page, `${commandRows}:not([aria-disabled="true"])`);
                    await page.press("Tab");
                    await until(
                        () => draft(page).then((text) => text === "/handoff reviewer "),
                        "reviewer role completes",
                    );
                    const rejected = "/handoff reviewer Keep this steering draft.\nDo not restart.";

                    await fill(page, composer, rejected);
                    await page.evaluate("window.handoffRejectNext = true");
                    await click(page, ".composer .send");
                    await until(
                        () =>
                            value<boolean>(
                                page,
                                "document.querySelector('.notices')?.textContent.includes('Fixture input rejected')",
                            ),
                        "definite submit rejection is visible",
                    );
                    assert.equal(
                        await draft(page),
                        rejected,
                        "a definite error preserves multiline steering for correction",
                    );
                    assert.equal(app.sessions().length, 1);
                    // Bare commands are real inputs too. A clarification must not reserve or
                    // create a provisional destination, and unmatched prose is not a usage error.
                    await fill(page, composer, "/handoff please");
                    await present(page, commandRows, false);
                    await fill(page, composer, "/handoff");
                    await click(page, ".composer .send");
                    await until(() => !app.isBusy(originId), "clarification settles");
                    await until(
                        () => draft(page).then((text) => text === ""),
                        "bare input accepted",
                    );
                    assert.equal(app.sessions().length, 1, "clarification creates no thread");
                    assert.equal(
                        (await app.workItems.list(originId, user)).workflow.preparing,
                        false,
                    );
                    const otherTab = await browsers.open(2);

                    await otherTab.setViewport(VIEWPORTS[viewport]);
                    await otherTab.navigate(
                        `${base}/login?token=${encodeURIComponent(app.config.ownerToken)}`,
                    );
                    await otherTab.navigate(`${base}/s/${origin.id}`);
                    await present(otherTab, composer);
                    const steering =
                        "Keep the exact reproduction.\nDo not restart, commit or publish.";
                    const dialog = '[role="dialog"][aria-label="Choose next thread"]';
                    const directionField = `${dialog} textarea`;
                    const popupRejected =
                        "/handoff reviewer --same\nInstructions:\nKeep this popup draft.\n--do-not-restart";
                    const command = `/handoff reviewer --same\nInstructions:\n${steering}`;

                    await click(page, ".topbar .handoff-button");
                    await present(page, `${dialog} input[value="reviewer:same-work"]`);
                    await click(page, `${dialog} input[value="reviewer:same-work"]`);
                    await button(page, dialog, "Next");
                    await fill(page, directionField, "Keep this popup draft.\n--do-not-restart");
                    await button(page, dialog, "Back");
                    await present(page, `${dialog} input[value="reviewer:same-work"]:checked`);
                    await button(page, dialog, "Next");
                    assert.equal(
                        await value(
                            page,
                            `document.querySelector(${JSON.stringify(directionField)}).value`,
                        ),
                        "Keep this popup draft.\n--do-not-restart",
                        "Back preserves steering and destination without sending",
                    );
                    assert.equal(await value(page, "window.handoffRequests.length"), 2);
                    await page.evaluate(
                        "window.handoffRejectNext = true; window.handoffHoldRejection = true",
                    );
                    await button(page, dialog, "Start thread");
                    await until(
                        () =>
                            value<boolean>(
                                page,
                                "typeof window.releaseHandoffRejection === 'function'",
                            ),
                        "input response is held while the popup remains dismissible",
                    );
                    await present(page, `${dialog} button[aria-label="Close"]:not(:disabled)`);
                    await page.press("Escape");
                    await present(page, dialog, false);
                    await click(page, ".topbar .handoff-button");
                    await present(page, `${dialog} input[value="reviewer:same-work"]:checked`);
                    await button(page, dialog, "Next");
                    await page.evaluate("window.releaseHandoffRejection()");
                    await until(
                        () =>
                            value<boolean>(
                                page,
                                "document.querySelector('.notices')?.textContent.includes('Reopen Handoff to retry your saved request')",
                            ),
                        "a late failure is reported outside the dismissed popup",
                    );
                    await present(page, dialog);
                    assert.equal(
                        await value(
                            page,
                            `document.querySelector(${JSON.stringify(directionField)}).value`,
                        ),
                        "Keep this popup draft.\n--do-not-restart",
                        "late failure neither closes the new opening nor discards its saved draft",
                    );
                    await fill(page, directionField, steering);
                    summaryGate = gate();
                    await page.evaluate("window.handoffRejectLookup = true");
                    await button(page, dialog, "Start thread");
                    await present(page, dialog, false);
                    await until(
                        () => handoffInputs.length === 1,
                        "model receives the real command",
                    );
                    assert.ok(handoffInputs[0]?.includes(steering));
                    await until(
                        () => draft(page).then((text) => text === ""),
                        "the independent composer draft remains untouched by picker acceptance",
                    );
                    assert.equal(
                        app.sessions().length,
                        1,
                        "held model creates no provisional thread",
                    );
                    assert.equal(
                        await value(page, "Number(location.pathname.split('/').at(-1))"),
                        origin.id,
                    );
                    await shot(page, `${viewport}-accepted-summary-pending`);
                    summaryGate.release();
                    summaryGate = undefined;
                    await until(() => app.sessions().length === 2, "tool creates the successor");
                    await until(
                        () =>
                            value<boolean>(
                                page,
                                "document.querySelector('.notices')?.textContent.includes('Could not check handoff navigation')",
                            ),
                        "disconnected lookup retains accepted opaque keys",
                    );
                    const requests = await value<Array<{ text: string; requestId: string }>>(
                        page,
                        "window.handoffRequests",
                    );
                    const accepted = await value<Array<{ handoffRequestKey: string }>>(
                        page,
                        "window.acceptedHandoffInputs",
                    );
                    const saved = await value<{
                        version: number;
                        requests: Array<{
                            sourceId: number;
                            userId: string;
                            handoffRequestKey: string;
                        }>;
                    }>(page, "JSON.parse(sessionStorage.getItem('pocket.handoffInputs'))");

                    assert.deepEqual(
                        requests.map((request) => request.text),
                        [rejected, "/handoff", popupRejected, command],
                    );
                    assert.ok(requests.every((request) => !("handoffVersion" in request)));
                    assert.ok(requests.every((request) => !("handoffRecoverOnly" in request)));
                    assert.equal(saved.version, 1);
                    assert.ok(
                        saved.requests.some(
                            (request) =>
                                request.handoffRequestKey === accepted.at(-1)?.handoffRequestKey,
                        ),
                    );
                    assert.ok(
                        saved.requests.every(
                            (request) =>
                                request.sourceId === origin.id && request.userId === user.id,
                        ),
                    );
                    assert.equal(await value(page, "window.legacyHandoffPosts"), 0);
                    assert.equal(
                        await value(otherTab, "Number(location.pathname.split('/').at(-1))"),
                        origin.id,
                        "another tab is never redirected",
                    );
                    assert.equal(
                        userInputs.filter(
                            (text) => text.replace(/^\[from:[^\]]+\]\s*/, "") === command,
                        ).length,
                        1,
                        "model sees the actual command once",
                    );
                    assert.equal(
                        userInputs.some((text) => text.includes("The human has requested a")),
                        false,
                        "app injects no fabricated source-summary request",
                    );

                    // Reload looks up a matching tool record without resubmitting user input.
                    await page.navigate(`${base}/s/${origin.id}`);
                    await present(page, ".topbar .title-sub .thread-type.reviewer");
                    await until(
                        () =>
                            value<boolean>(
                                page,
                                "sessionStorage.getItem('pocket.handoffInputs') === null",
                            ),
                        "completed matching record clears saved navigation",
                    );
                    await until(
                        () => app.sessions().every((session) => !session.busy),
                        "reviewer delivery settles",
                    );
                    const reviewer = app
                        .sessions()
                        .find((session) => session.threadType === "reviewer")!;
                    const reviewerId = reviewer.id as ConversationId;

                    await until(
                        () => app.sessionMeta(reviewerId)?.title === namedTitle,
                        "successor is named from its received summary",
                    );
                    assert.equal(app.sessions().length, 2);
                    assert.equal(handoffInputs.length, 1);
                    assert.equal(titleRequests, 1);
                    await present(page, '.composer [aria-label="Work Item context"]');
                    await present(page, '.composer [aria-label="Previous thread"]');
                    await app.commands.updateSession(reviewerId, user, {
                        title: "独立 review matching member",
                    });
                    await home(page);
                    const workItem = `${scope} [data-work-item-id="${reviewer.workItemId}"]`;
                    const memberRow = `${workItem} .work-item-member[data-id="${origin.id}"]`;

                    await present(page, workItem);
                    assert.deepEqual(
                        await value(
                            page,
                            `[...document.querySelectorAll(${JSON.stringify(`${workItem} .work-item-member`)})].map(row => Number(row.dataset.id))`,
                        ),
                        [origin.id, reviewer.id],
                        "same-work membership renders once and in admission order",
                    );
                    assert.deepEqual(
                        await value(
                            page,
                            `[...document.querySelectorAll(${JSON.stringify(`${workItem} .work-item-member .session-state [role="img"]`)})].map(icon => icon.getAttribute('aria-label'))`,
                        ),
                        ["Worker", "Reviewer"],
                    );
                    assert.equal(
                        await value(
                            page,
                            `document.querySelector(${JSON.stringify(`${workItem} .work-item-disclosure [role="img"]`)}).getAttribute('aria-label')`,
                        ),
                        "Reviewer",
                    );
                    assert.equal(
                        await value(
                            page,
                            `document.querySelectorAll(${JSON.stringify(`${workItem} .work-item-member .session-meta .thread-type`)}).length`,
                        ),
                        0,
                        "accessible leading stage icons are not duplicated",
                    );
                    assert.equal(
                        await value(
                            page,
                            `document.querySelectorAll(${JSON.stringify(`${workItem} .work-item-member .session-move, ${workItem} .work-item-member [aria-label="Archive"]`)}).length`,
                        ),
                        0,
                    );
                    assert.equal(
                        await value(
                            page,
                            `document.querySelector(${JSON.stringify(`${memberRow} .session`)}).draggable`,
                        ),
                        false,
                    );
                    await rowOptions(page, memberRow, viewport);
                    const memberActions = await value<string[]>(
                        page,
                        `[...document.querySelectorAll(${JSON.stringify(`${optionsSurface} .sidebar-option`)})].map(button => button.textContent.trim())`,
                    );

                    assert.equal(
                        memberActions.some((label) => /Move|Archive|Restore/.test(label)),
                        false,
                    );
                    assert.ok(memberActions.includes("Rename…"));
                    await button(page, optionsSurface, "Work Item options…");
                    await until(
                        () =>
                            value<boolean>(
                                page,
                                `[...document.querySelectorAll(${JSON.stringify(`${optionsSurface} button`)})].some(button => button.textContent.trim() === 'Archive Work Item')`,
                            ),
                        "member menu routes to whole-item actions",
                    );
                    await page.press("Escape");
                    await present(page, optionsSurface, false);
                    await fill(page, `${scope} .search input`, "独立");
                    await present(page, workItem);
                    assert.equal(
                        await value(
                            page,
                            `document.querySelectorAll(${JSON.stringify(`${workItem} .work-item-member`)}).length`,
                        ),
                        2,
                        "search retains the matching member's parent and siblings",
                    );
                    await fill(page, `${scope} .search input`, "");
                    await button(page, `${scope} .session-tabs`, "Recent");
                    const beforeCollapse = await value(page, "location.href");

                    await click(page, `${workItem} .work-item-disclosure`);
                    await present(page, `${workItem} .work-item-member`, false);
                    assert.equal(await value(page, "location.href"), beforeCollapse);
                    await page.evaluate(
                        `document.querySelector(${JSON.stringify(`${workItem} .work-item-disclosure`)}).focus()`,
                    );
                    await page.press("Enter");
                    await present(page, `${workItem} .work-item-member`);
                    await click(page, `${memberRow} .session`);
                    await present(page, '.composer [aria-label="Read-only workspace"]');
                    await present(page, composer);
                    await click(page, '.composer [aria-label="Open active thread"]');
                    await present(page, ".topbar .title-sub .thread-type.reviewer");

                    const newScope =
                        "Start a separate accessibility task.\nDo not inherit the old review as approval.";

                    summaryGate = gate();
                    await fill(page, composer, `Please hand off to a new worker. ${newScope}`);
                    await click(page, ".composer .send");
                    await until(
                        () => handoffInputs.length === 2,
                        "English input reaches the model",
                    );
                    assert.ok(handoffInputs[1]?.includes(newScope));
                    await until(
                        () => draft(page).then((text) => text === ""),
                        "English input clears on acceptance",
                    );
                    assert.ok(
                        await value<boolean>(
                            page,
                            "JSON.parse(sessionStorage.getItem('pocket.handoffInputs')).requests.some(request => typeof request.handoffRequestKey === 'string')",
                        ),
                        "ordinary English also saves a navigation key",
                    );
                    await click(page, '.composer [aria-label="Previous thread"]');
                    await present(page, '.composer [aria-label="Read-only workspace"]');
                    assert.equal(
                        await value(page, "sessionStorage.getItem('pocket.handoffInputs')"),
                        null,
                        "leaving the source clears navigation intent immediately",
                    );
                    summaryGate.release();
                    summaryGate = undefined;
                    await until(
                        () =>
                            app.sessions().length === 3 &&
                            app.sessions().every((session) => !session.busy),
                        "new Work Item delivery settles after leaving the source",
                    );
                    assert.equal(
                        await value(page, "Number(location.pathname.split('/').at(-1))"),
                        origin.id,
                        "late handoff success does not steal navigation from another thread",
                    );
                    const newWorker = app
                        .sessions()
                        .find(
                            (session) =>
                                session.threadType === "worker" && session.id !== origin.id,
                        )!;

                    assert.notEqual(newWorker.workItemId, reviewer.workItemId);
                    await home(page);
                    const nextItem = `${scope} [data-work-item-id="${newWorker.workItemId}"]`;

                    await present(page, nextItem);
                    assert.equal(
                        await value(
                            page,
                            `document.querySelectorAll(${JSON.stringify(`${scope} [data-work-item-id]`)}).length`,
                        ),
                        2,
                    );
                    await click(page, `${nextItem} > .work-item-head .session`);
                    await present(page, '.composer [aria-label="Previous Work Item"]');
                    await present(page, ".topbar .handoff-button", false);
                    await home(page);

                    // Whole-item controls must update every member but not another Work Item in
                    // the same project. No member menu or drag can split the original group.
                    const members = () =>
                        app
                            .sessions()
                            .filter((session) => session.workItemId === reviewer.workItemId);

                    await rowOptions(page, `${workItem} > .work-item-head`, viewport);
                    await button(page, optionsSurface, "Move Work Item to project…");
                    await page.evaluate(
                        `const field = document.querySelector('[role="dialog"] [aria-label="Project"]'); field.value = ''; field.dispatchEvent(new Event('change', { bubbles: true }));`,
                    );
                    await button(page, '[role="dialog"]', "Move");
                    await until(
                        () => members().every((session) => session.projectId === undefined),
                        "all members move together",
                    );
                    assert.equal(
                        app.sessionMeta(newWorker.id as ConversationId)?.projectId,
                        project.id,
                    );
                    await present(page, '[role="dialog"]', false);
                    await rowOptions(page, `${workItem} > .work-item-head`, viewport);
                    await button(page, optionsSurface, "Archive Work Item");
                    await until(
                        () => members().every((session) => session.archived),
                        "all members archive together",
                    );
                    assert.notEqual(
                        app.sessionMeta(newWorker.id as ConversationId)?.archived,
                        true,
                    );
                    await button(page, `${scope} .session-tabs`, "Archived");
                    await present(page, workItem);
                    await rowOptions(page, `${workItem} > .work-item-head`, viewport);
                    await button(page, optionsSurface, "Restore Work Item");
                    await until(
                        () => members().every((session) => !session.archived),
                        "all members restore together",
                    );
                    await button(page, `${scope} .session-tabs`, "Recent");
                    assert.equal(
                        await value(page, "document.documentElement.scrollWidth <= innerWidth"),
                        true,
                        "argument suggestions and Work Items fit mobile and desktop widths",
                    );
                    await shot(page, `${viewport}-agent-handoff-work-items`);

                    // The tool may publish retirement before /submit's acceptance reaches this
                    // tab. Once the real response arrives, the saved key must inspect that already
                    // received session state instead of waiting forever for another event.
                    const fastSource = await app.commands.createSession(user, {
                        cwd,
                        threadType: "worker",
                        title: "Fast handoff acceptance",
                    });
                    const fastSourceId = fastSource.id as ConversationId;

                    await app.commands.configure(fastSourceId, user, {
                        model: { provider: "faux", modelId: "faux-1" },
                        thinkingLevel: "off",
                    });
                    await page.navigate(`${base}/s/${fastSource.id}`);
                    await present(page, composer);
                    await page.evaluate(`const fetchOriginal = window.fetch.bind(window);
                        window.releaseAcceptedResponse = null;
                        window.fetch = async (url, options) => {
                            const response = await fetchOriginal(url, options);

                            if (/\\/api\\/c\\/\\d+\\/submit$/.test(String(url)) && options?.method === 'POST' && response.ok) {
                                await new Promise(resolve => { window.releaseAcceptedResponse = resolve; });
                            }

                            return response;
                        };`);
                    const acceptedDraft = "/handoff researcher Investigate the retry race.";

                    await fill(page, composer, acceptedDraft);
                    await click(page, ".composer .send");
                    await until(
                        () => app.sessions().length === 5,
                        "tool completes before the held HTTP acceptance",
                    );
                    await present(page, '.composer [aria-label="Read-only workspace"]');
                    await until(
                        () =>
                            value<boolean>(
                                page,
                                "typeof window.releaseAcceptedResponse === 'function'",
                            ),
                        "real submit response is held at the transport",
                    );
                    assert.equal(
                        await value(page, "Number(location.pathname.split('/').at(-1))"),
                        fastSource.id,
                    );
                    // Edit then undo to the identical string: equality is not a draft-generation guard.
                    const laterDraft = acceptedDraft;

                    await fill(page, composer, "A temporary edit made after sending.");
                    await fill(page, composer, laterDraft);
                    await page.evaluate("window.releaseAcceptedResponse()");
                    await present(page, ".topbar .title-sub .thread-type.researcher");
                    assert.equal(
                        app.sessions().filter((session) => session.threadType === "researcher")
                            .length,
                        1,
                    );
                    assert.equal(
                        await value(page, "sessionStorage.getItem('pocket.handoffInputs')"),
                        null,
                    );
                    await page.navigate(`${base}/s/${fastSource.id}`);
                    await present(page, composer);
                    assert.equal(
                        await draft(page),
                        laterDraft,
                        "late acceptance never erases a newer edit/undo draft with identical text",
                    );

                    // Lost success is not rejection. Block passive receipt reads so an explicit
                    // retry must reuse the persisted POST identity even if busy mode has changed.
                    const retrySource = await app.commands.createSession(user, {
                        cwd,
                        threadType: "worker",
                        title: "Uncertain input recovery",
                    });
                    const retryId = retrySource.id as ConversationId;

                    await app.commands.configure(retryId, user, {
                        model: { provider: "faux", modelId: "faux-1" },
                        thinkingLevel: "off",
                    });
                    await page.navigate(`${base}/s/${retrySource.id}`);
                    await present(page, composer);
                    await page.evaluate(`const fetchOriginal = window.fetch.bind(window);
                        window.retrySubmissions = [];
                        window.loseAcceptedResponse = true;
                        window.rejectReceiptLookups = true;
                        window.fetch = async (url, options) => {
                            const address = String(url);
                            const submitted = /\\/api\\/c\\/\\d+\\/submit$/.test(address) && options?.method === 'POST';

                            if (/\\/api\\/c\\/\\d+\\/submit\\?/.test(address) && window.rejectReceiptLookups) {
                                return new Response(JSON.stringify({ error: 'Fixture receipt unavailable' }), { status: 503 });
                            }

                            if (submitted) {
                                window.retrySubmissions.push(JSON.parse(options.body));
                            }

                            const response = await fetchOriginal(url, options);

                            if (submitted && response.ok && window.loseAcceptedResponse) {
                                window.loseAcceptedResponse = false;

                                throw new TypeError('Fixture accepted response lost');
                            }

                            return response;
                        };`);
                    const lostDraft = "Keep this uncertain input identity.";

                    await fill(page, composer, lostDraft);
                    await click(page, ".composer .send");
                    await until(
                        () =>
                            value<boolean>(
                                page,
                                "document.querySelector('.notices')?.textContent.includes('Fixture accepted response lost')",
                            ),
                        "accepted response is lost at the transport",
                    );
                    assert.equal(await draft(page), lostDraft);
                    await until(() => !app.isBusy(retryId), "accepted original input settles");
                    const uncertain = await value<{ requests: Array<{ requestId: string }> }>(
                        page,
                        "JSON.parse(sessionStorage.getItem('pocket.submitAttempts'))",
                    );

                    assert.equal(uncertain.requests.length, 1);
                    replyGate = gate();
                    await app.commands.submit(retryId, user, {
                        text: holdMessage,
                        requestId: `hold-retry-${viewport}`,
                    });
                    await until(() => app.isBusy(retryId), "another reply changes the retry mode");
                    await present(page, ".composer .send");
                    await until(
                        () =>
                            value<boolean>(
                                page,
                                "document.querySelector('.composer .send')?.getAttribute('title')?.includes('Steer') || document.querySelector('.composer textarea')?.placeholder.includes('Steer')",
                            ),
                        "composer receives the busy state before retry",
                    );
                    await click(page, ".composer .send");
                    await until(
                        () => draft(page).then((text) => text === ""),
                        "explicit retry accepts",
                    );
                    const retried = await value<Array<{ requestId: string; mode: string }>>(
                        page,
                        "window.retrySubmissions",
                    );

                    assert.equal(retried.length, 2);
                    assert.equal(retried[0]!.requestId, uncertain.requests[0]!.requestId);
                    assert.equal(retried[1]!.requestId, retried[0]!.requestId);
                    assert.notEqual(retried[0]!.mode, retried[1]!.mode);
                    replyGate.release();
                    replyGate = undefined;
                    await until(() => !app.isBusy(retryId), "held reply settles");
                    assert.equal(
                        userInputs.filter(
                            (text) => text.replace(/^\[from:[^\]]+\]\s*/, "") === lostDraft,
                        ).length,
                        1,
                        "explicit retry places the real input only once",
                    );

                    // Different drafts get independent identities, retaining the earlier uncertainty.
                    // Reload then resolves both real server receipts without replaying either POST.
                    const reloadDrafts = ["An older uncertain input.", "A newer uncertain input."];

                    for (const text of reloadDrafts) {
                        await page.evaluate("window.loseAcceptedResponse = true");
                        await fill(page, composer, text);
                        await click(page, ".composer .send");
                        await until(
                            () =>
                                value<boolean>(
                                    page,
                                    "window.loseAcceptedResponse === false && !document.querySelector('.composer .send')?.disabled",
                                ),
                            "lost acceptance preserves its editable draft",
                        );
                        await until(() => !app.isBusy(retryId), "uncertain input settles");
                    }

                    const pending = await value<{ requests: Array<{ requestId: string }> }>(
                        page,
                        "JSON.parse(sessionStorage.getItem('pocket.submitAttempts'))",
                    );

                    assert.equal(pending.requests.length, 2);
                    assert.notEqual(pending.requests[0]!.requestId, pending.requests[1]!.requestId);
                    await page.navigate(`${base}/s/${retrySource.id}`);
                    await present(page, composer);
                    await until(
                        () =>
                            value<boolean>(
                                page,
                                "JSON.parse(sessionStorage.getItem('pocket.submitAttempts'))?.requests.every(request => request.receipt?.handoffRequestKey)",
                            ),
                        "passive recovery finds both accepted receipts after reload",
                    );
                    await page.evaluate(`const fetchOriginal = window.fetch.bind(window);
                        window.recoveryPosts = 0;
                        window.fetch = (url, options) => {
                            if (/\\/api\\/c\\/\\d+\\/submit$/.test(String(url)) && options?.method === 'POST') {
                                window.recoveryPosts++;
                            }

                            return fetchOriginal(url, options);
                        };`);
                    assert.equal(await draft(page), reloadDrafts[1]);
                    await click(page, ".composer .send");
                    await until(
                        () => draft(page).then((text) => text === ""),
                        "saved acceptance clears the still-visible draft",
                    );
                    await fill(page, composer, reloadDrafts[0]!);
                    await click(page, ".composer .send");
                    await until(
                        () => draft(page).then((text) => text === ""),
                        "older saved acceptance also remains idempotent",
                    );
                    assert.equal(
                        await value(page, "window.recoveryPosts"),
                        0,
                        "receipt recovery never replays POST",
                    );
                    assert.equal(
                        await value(page, "sessionStorage.getItem('pocket.submitAttempts')"),
                        null,
                    );

                    for (const text of reloadDrafts) {
                        assert.equal(
                            userInputs.filter(
                                (input) => input.replace(/^\[from:[^\]]+\]\s*/, "") === text,
                            ).length,
                            1,
                            "reload and explicit send never duplicate accepted human input",
                        );
                    }
                } finally {
                    replyGate?.release();
                    summaryGate?.release();
                    await browsers.closeAll({ final: true });
                    await app.close();
                    server.closeAllConnections();
                    await new Promise<void>((resolve) => server.close(() => resolve()));
                }
            });
        }
    },
);
