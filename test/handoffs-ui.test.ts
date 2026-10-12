// Authoring gate: browser activation, retry identity, native slash routing and group organization are public UI contracts.
// Chooser regressions: hidden disabled paths, auto-start on a sole option, lost recommendation reasons,
// target-locked prepared briefs, stale readiness and new roles falling back to Worker are not exercised by backend tests.
// Role defaults must not restart review after Follow-up, pick Chat merely by server ordering,
// or pretend to be agent recommendations; explicit role activation alone does not catch those regressions.
// A lost create response freezes the admitted role/request for recovery; a definite initial rejection leaves refresh available.
// An uncertain retry's later rejection cannot prove that the original admission failed.
// Member search must not orphan or duplicate its Work Item.
// Backend tests own ownership, transition validation and access; this owns rendered forms, navigation and group actions.
// All sessions, git commits and browser profiles are disposable fixtures; no production test seams or live user data.
import {
    cleanUp,
    lastText,
    openApp,
    owner,
    root,
    say,
    scriptedModel,
    until,
    work,
} from "./helpers.ts";
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
        field.value = ${JSON.stringify(text)};
        field.dispatchEvent(new InputEvent('input', { bubbles: true }));`);
}

async function select(page: BrowserPage, selector: string, option: string) {
    await present(page, selector);
    await page.evaluate(`const field = document.querySelector(${JSON.stringify(selector)});
        field.value = ${JSON.stringify(option)};
        field.dispatchEvent(new Event('change', { bubbles: true }));`);
}

async function defaultChoice(page: BrowserPage, type: string) {
    await click(page, ".topbar .handoff-button");
    await present(page, `${dialog} input[value="${type}:same-work"]:checked`);
    assert.equal(
        await value(page, `document.querySelectorAll('${dialog} .handoff-recommendation').length`),
        0,
        "a role-aware default is not an agent recommendation",
    );
    await button(page, dialog, "Cancel");
    await present(page, dialog, false);
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

const previewHtml =
    '<!doctype html><html><body><h1>Static fixture preview</h1><script>document.body.dataset.executed = "yes"; parent.postMessage({ type: "preview-ui-fixture" }, "*");</script></body></html>';
const dialog = '[role="dialog"][aria-label="Handoff"]';
const optionsSurface = ":is(.sidebar-options-menu, .sidebar-options-sheet)";

async function rowOptions(page: BrowserPage, row: string, viewport: "desktop" | "mobile") {
    if (viewport === "mobile") {
        await click(page, `${row} .session-options`);
    } else {
        await page.evaluate(`document.querySelector(${JSON.stringify(`${row} .session`)}).focus()`);
        await page.press("Shift+F10");
    }

    await present(page, optionsSurface);
}

async function choose(page: BrowserPage, type: string, relationship = "same-work") {
    await click(page, `${dialog} input[value="${type}:${relationship}"]`);
}

test(
    "Handoffs UI: full role chooser, advisory recommendations, durable retry and indivisible Work Items",
    {
        skip: findBrowser() === undefined ? "no Chromium installed" : false,
        timeout: 180_000,
    },
    async (t) => {
        for (const viewport of ["desktop", "mobile"] as const) {
            await t.test(viewport, async () => {
                const cwd = join(work, `handoff-${viewport}`);

                mkdirSync(cwd);
                writeFileSync(join(cwd, "fixture.txt"), "Disposable handoff checkout\n");
                writeFileSync(join(cwd, "preview.html"), previewHtml);
                execFileSync("git", ["init", cwd]);
                execFileSync("git", ["-C", cwd, "add", "fixture.txt", "preview.html"]);
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

                const remote = join(work, `handoff-${viewport}-published.git`);

                execFileSync("git", ["init", "--bare", remote]);
                execFileSync("git", ["-C", cwd, "remote", "add", "fixture", remote]);

                let release = () => {};

                const held = new Promise<void>((resolve) => {
                    release = resolve;
                });

                let releaseBusy = () => {};

                const busyCheck = new Promise<void>((resolve) => {
                    releaseBusy = resolve;
                });
                const model = scriptedModel(async (request) => {
                    const last = lastText(request as never);
                    const text = last.text;

                    if (last.role === "user" && text.endsWith("PREVIEW_HTML_FIXTURE")) {
                        return fauxAssistantMessage(
                            [
                                fauxToolCall("artifact", {
                                    id: "existing-preview",
                                    title: "Existing preview fixture",
                                    content: previewHtml,
                                }),
                            ],
                            { stopReason: "toolUse" },
                        );
                    }

                    if (
                        text.includes(
                            'Published "Existing preview fixture" as artifact existing-preview',
                        )
                    ) {
                        return fauxAssistantMessage(`\`\`\`html\n${previewHtml}\n\`\`\``);
                    }

                    if (last.role === "user" && text.endsWith("PREPARE_PREVIEW_GATE")) {
                        return fauxAssistantMessage(
                            [
                                fauxToolCall("handoff", {
                                    action: "prepare",
                                    targetType: "reviewer",
                                    relationship: "same-work",
                                    brief: "Review the disposable preview fixture.",
                                }),
                            ],
                            { stopReason: "toolUse" },
                        );
                    }

                    if (last.role === "user" && text.endsWith("UI_BUSY_CHECK")) {
                        await busyCheck;
                    }

                    if (last.role === "user" && text.endsWith("UI_WORKER_READY")) {
                        return fauxAssistantMessage(
                            [
                                fauxToolCall("handoff", {
                                    action: "prepare",
                                    targetType: "follow-up",
                                    relationship: "same-work",
                                    brief: "Independently review this checkout. Fixture tests passed; no known risks.",
                                    recommendations: [
                                        {
                                            targetType: "follow-up",
                                            relationship: "same-work",
                                            reason: "Only a bounded fix and self-review remain.",
                                        },
                                        {
                                            targetType: "pull",
                                            relationship: "same-work",
                                            reason: "Upstream changes may need integration first.",
                                        },
                                    ],
                                }),
                            ],
                            { stopReason: "toolUse" },
                        );
                    }

                    if (last.role === "user" && text.endsWith("UI_APPROVED_PUBLISH")) {
                        return fauxAssistantMessage(
                            [
                                fauxToolCall("publication", {
                                    action: "execute",
                                    command: [
                                        "git",
                                        "push",
                                        "fixture",
                                        "HEAD:refs/heads/ui-tested",
                                    ],
                                    reason: "Publish only this fixture commit to its disposable local remote.",
                                }),
                            ],
                            { stopReason: "toolUse" },
                        );
                    }

                    const outcomes = {
                        UI_REVIEW_READY: {
                            status: "review-complete",
                            summary: "Independent review passed.",
                            recommendations: [
                                {
                                    targetType: "land",
                                    relationship: "same-work",
                                    reason: "The reviewed checkout is ready for local landing.",
                                },
                            ],
                        },
                        UI_FOLLOW_UP_READY: {
                            status: "review-complete",
                            summary: "Bounded fixes and self-review passed.",
                        },
                        UI_LAND_READY: {
                            status: "landed",
                            summary: "Locally landed; quick impact review passed.",
                            readyForPublish: true,
                            recommendations: [
                                {
                                    targetType: "publish",
                                    relationship: "same-work",
                                    reason: "Local verification passed; publication still needs approval.",
                                },
                            ],
                        },
                        UI_PUBLISH_DONE: {
                            status: "published",
                            summary: "Fixture delivery complete; no real external action.",
                        },
                    };
                    const outcome = Object.entries(outcomes).find(
                        ([trigger]) => last.role === "user" && text.endsWith(trigger),
                    )?.[1];

                    if (outcome) {
                        return fauxAssistantMessage(
                            [fauxToolCall("handoff", { action: "complete", ...outcome })],
                            { stopReason: "toolUse" },
                        );
                    }

                    if (text.includes("held predecessor question")) {
                        await held;
                    }

                    return fauxAssistantMessage(`echo: ${text}`);
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
                    await present(page, '.topbar .handoff-button[aria-label="Choose next thread"]');
                    const beforeEmptyPicker = app.sessions().length;

                    await click(page, ".topbar .handoff-button");
                    await present(page, `${dialog} input[name="handoff-option"]`);
                    assert.deepEqual(
                        await value(
                            page,
                            `[...document.querySelectorAll(${JSON.stringify(`${dialog} input[name="handoff-option"]`)})].map(input => input.value).sort()`,
                        ),
                        [
                            "chat:same-work",
                            "follow-up:same-work",
                            "land:same-work",
                            "publish:same-work",
                            "pull:same-work",
                            "reviewer:same-work",
                            "worker:new-work",
                            "worker:same-work",
                        ],
                        "empty threads still show every server path, including unavailable stages",
                    );
                    assert.equal(
                        await value(
                            page,
                            `document.querySelector('${dialog} input[value="reviewer:same-work"]').disabled`,
                        ),
                        true,
                        "an empty thread cannot start an independent review",
                    );
                    assert.equal(
                        await value(
                            page,
                            `document.querySelector('${dialog} input[value="reviewer:same-work"]').closest('label').textContent.includes('completed')`,
                        ),
                        true,
                        "the unavailable reviewer explains its missing completed work",
                    );
                    assert.equal(
                        await value(
                            page,
                            `document.querySelector('${dialog} input[value="land:same-work"]').disabled && document.querySelector('${dialog} input[value="publish:same-work"]').disabled`,
                        ),
                        true,
                        "checkpoint-gated stages remain visible but disabled",
                    );
                    await shot(page, `${viewport}-empty-role-chooser`);
                    await button(page, dialog, "Cancel");
                    assert.equal(
                        app.sessions().length,
                        beforeEmptyPicker,
                        "choosing a role never auto-starts work",
                    );

                    const busyRun = say(app, originId, "UI_BUSY_CHECK");

                    await until(() => app.isBusy(originId), "worker held in an active model run");
                    await click(page, ".topbar .handoff-button");
                    await present(page, `${dialog} input[name="handoff-option"]`);
                    assert.equal(
                        await value(
                            page,
                            `[...document.querySelectorAll('${dialog} input[name="handoff-option"]')].every(input => input.disabled && input.closest('label').querySelector('.handoff-disabled-reason')?.textContent.trim())`,
                        ),
                        true,
                        "busy work disables every role with the server's reason, without hiding the picker",
                    );
                    assert.equal(
                        await value(
                            page,
                            `document.querySelector('${dialog} button[type="submit"]').disabled`,
                        ),
                        true,
                        "no disabled fallback can be activated",
                    );
                    releaseBusy();
                    await busyRun;
                    await button(page, dialog, "Refresh options");
                    await present(
                        page,
                        `${dialog} input[value="reviewer:same-work"]:not(:disabled):checked`,
                    );
                    await choose(page, "pull");
                    await page.evaluate(`const fetchBeforeRefresh = window.fetch.bind(window);
                        window.handoffRefreshLoads = 0;
                        window.fetch = async (url, options) => {
                            const response = await fetchBeforeRefresh(url, options);

                            if (String(url).endsWith('/handoffs') && options?.method !== 'POST') {
                                window.handoffRefreshLoads++;
                            }

                            return response;
                        };`);
                    await button(page, dialog, "Refresh options");
                    await until(
                        () => value<boolean>(page, "window.handoffRefreshLoads >= 1"),
                        "refresh reloads server eligibility",
                    );
                    await present(page, `${dialog} .loader`, false);
                    assert.equal(
                        await value(
                            page,
                            `document.querySelector('${dialog} input[value="pull:same-work"]').checked`,
                        ),
                        true,
                        "refreshing readiness preserves a human's still-enabled selection",
                    );
                    await button(page, dialog, "Cancel");
                    const chat = await app.commands.createSession(owner(app), {
                        cwd,
                        threadType: "chat",
                        title: "Disposable HTML preview",
                    });
                    const chatId = chat.id as ConversationId;

                    await app.commands.configure(chatId, user, {
                        model: { provider: "faux", modelId: "faux-1" },
                        thinkingLevel: "off",
                    });
                    await page.evaluate(`(await import('/store.js')).navigate(${chat.id})`);
                    await say(app, chatId, "PREVIEW_HTML_FIXTURE");
                    await defaultChoice(page, "worker");
                    const richPreview = ".transcript .rich.html";

                    await present(page, `${richPreview} .html-preview`);
                    assert.equal(
                        await value(
                            page,
                            `document.querySelector(${JSON.stringify(`${richPreview} .html-preview`)}).contentDocument.body.dataset.executed ?? null`,
                        ),
                        null,
                        "static HTML never executes scripts",
                    );
                    await page.evaluate(`window.previewExecutions = 0;
                        addEventListener('message', event => { if (event.data?.type === 'preview-ui-fixture') { window.previewExecutions++; } });`);
                    await click(page, `${richPreview} .rich-run`);
                    await present(page, `${richPreview} .run-frame`);
                    assert.equal(
                        await value(
                            page,
                            `document.querySelector(${JSON.stringify(`${richPreview} .run-frame`)}).getAttribute('src')`,
                        ),
                        `/a/frame/${chat.id}`,
                        "runnable replies bind the server sandbox to their source conversation",
                    );
                    await until(
                        () => value<boolean>(page, "window.previewExecutions === 1"),
                        "unmanaged source's explicitly started fixture script runs",
                    );
                    await say(app, chatId, "PREPARE_PREVIEW_GATE");
                    await present(page, `${richPreview} .run-frame`, false);
                    await present(page, `${richPreview} .rich-run`, false);
                    await present(page, `${richPreview} .html-preview`);
                    assert.equal(
                        await value(
                            page,
                            `document.querySelector(${JSON.stringify(`${richPreview} .html-preview`)}).contentDocument.body.dataset.executed ?? null`,
                        ),
                        null,
                        "preparation stops existing runnable content even in memoized older transcript rows",
                    );
                    await button(page, `${richPreview} .rich-tabs`, "Code");
                    assert.equal(
                        await value(
                            page,
                            `document.querySelector(${JSON.stringify(`${richPreview} pre`)}).textContent.includes('preview-ui-fixture')`,
                        ),
                        true,
                        "managed previews retain their readable source code",
                    );
                    await button(page, `${richPreview} .rich-tabs`, "Preview");
                    await click(page, ".transcript .artifact-link");
                    await present(page, ".viewer [role='status']");
                    await present(page, ".viewer iframe", false);
                    assert.equal(
                        await value(
                            page,
                            "document.querySelector('.viewer [role=status]').textContent.includes('disabled')",
                        ),
                        true,
                        "existing managed artifacts show a notice instead of requesting an executable frame",
                    );
                    assert.equal(
                        await value(
                            page,
                            "Boolean(document.querySelector('.viewer a[target=_blank]'))",
                        ),
                        false,
                        "managed artifacts cannot bypass the notice through Open tab",
                    );
                    await click(page, '.viewer [aria-label="Close"]');
                    await present(page, ".viewer", false);
                    await page.evaluate(
                        `(await import('/store.js')).openSheet({ type: 'file', id: ${JSON.stringify(join(cwd, "preview.html"))} })`,
                    );
                    await button(page, ".file-tools", "Preview");
                    await present(page, ".file-viewer .html-preview");
                    assert.equal(
                        await value(
                            page,
                            "[...document.querySelectorAll('.file-tools button')].some(button => button.textContent.includes('Run'))",
                        ),
                        false,
                        "managed file previews expose no Run escape hatch",
                    );
                    await click(page, '.sheet-head [aria-label="Close"]');
                    await present(page, '[role="dialog"]', false);
                    await app.commands.updateSession(chatId, owner(app), { archived: true });
                    await page.evaluate(`(await import('/store.js')).navigate(${origin.id})`);
                    await say(app, originId, "UI_WORKER_READY");
                    const countBeforeHandoff = app.sessions().length;

                    await present(page, '.topbar .handoff-button[aria-label="Choose next thread"]');
                    assert.equal(
                        await value(
                            page,
                            "document.querySelector('.topbar .handoff-button').textContent.trim()",
                        ),
                        "",
                        "handoff is a target-stage icon, not another text button",
                    );

                    // Drop the successful response at the real fetch boundary, after the server admitted the handoff.
                    await page.evaluate(`const fetchOriginal = window.fetch.bind(window);
                    window.handoffRequests = [];
                    window.handoffOptionReads = 0;
                    window.handoffLoseNext = true;
                    window.fetch = async (url, options) => {
                        const match = /\\/api\\/c\\/\\d+\\/handoffs$/.test(String(url)) && options?.method === 'POST';

                        if (match) {
                            window.handoffRequests.push(JSON.parse(options.body));

                            if (window.handoffRejectNext) {
                                window.handoffRejectNext = false;

                                return new Response(JSON.stringify({ error: 'Fixture handoff rejected: helper still busy' }), { status: 409 });
                            }
                        } else if (String(url).endsWith('/handoffs')) {
                            window.handoffOptionReads++;
                        }

                        const result = await fetchOriginal(url, options);

                        if (window.legacyHandoffOptions && String(url).endsWith('/handoffs') && options?.method !== 'POST' && result.ok) {
                            const data = await result.json();

                            data.options = data.options.filter(option => option.targetType === 'reviewer');

                            return new Response(JSON.stringify(data), { status: result.status, headers: result.headers });
                        }

                        if (match && result.ok && window.handoffLoseNext) {
                            window.handoffLoseNext = false;

                            throw new Error('Fixture lost create response');
                        }

                        return result;
                    };`);
                    await page.evaluate("window.legacyHandoffOptions = true");
                    await click(page, ".topbar .handoff-button");
                    await present(page, `${dialog} input[value="reviewer:same-work"]:checked`);
                    assert.equal(
                        await value(
                            page,
                            `document.querySelectorAll('${dialog} input[name="handoff-option"]').length`,
                        ),
                        1,
                        "an older server's sole enabled path still opens the chooser",
                    );
                    assert.equal(await value(page, "window.handoffRequests.length"), 0);
                    await button(page, dialog, "Cancel");
                    await page.evaluate("window.legacyHandoffOptions = false");
                    await click(page, ".topbar .handoff-button");
                    await present(page, `${dialog} input[value="follow-up:same-work"]:checked`);
                    assert.equal(
                        await value(page, "window.handoffRequests.length"),
                        0,
                        "the header always opens a chooser, never creates a successor",
                    );
                    await choose(page, "reviewer");
                    assert.deepEqual(
                        await value(
                            page,
                            `[...document.querySelectorAll('${dialog} .handoff-recommendation')].map(element => element.textContent.trim())`,
                        ),
                        [
                            "Recommended · Only a bounded fix and self-review remain.",
                            "Recommended · Upstream changes may need integration first.",
                        ],
                        "both recommendations and their reasons remain visible after picking a different enabled role",
                    );
                    await shot(page, `${viewport}-advisory-recommendations`);
                    await page.evaluate("window.handoffRejectNext = true");
                    await button(page, dialog, "Start review");
                    await present(page, `${dialog} .error`);
                    assert.equal(
                        await value(
                            page,
                            `[...document.querySelectorAll('${dialog} button')].find(button => button.textContent.trim() === 'Refresh options').disabled`,
                        ),
                        false,
                        "a definite rejection leaves eligibility refresh available",
                    );
                    assert.equal(app.sessions().length, countBeforeHandoff);
                    const readsBeforeRefresh = await value<number>(
                        page,
                        "window.handoffOptionReads",
                    );

                    await button(page, dialog, "Refresh options");
                    await until(
                        () =>
                            value<boolean>(
                                page,
                                `window.handoffOptionReads > ${readsBeforeRefresh} && !document.querySelector('${dialog} .loader')`,
                            ),
                        "eligibility reloads after the rejected admission",
                    );
                    await present(page, `${dialog} input[value="reviewer:same-work"]:checked`);
                    await choose(page, "follow-up");
                    await choose(page, "reviewer");
                    await button(page, dialog, "Start review");
                    await until(
                        () => value<boolean>(page, "window.handoffRequests.length === 2"),
                        "explicit selection activates review",
                    );
                    await present(page, `${dialog} .error`);
                    assert.equal(
                        await value(
                            page,
                            `[...document.querySelectorAll('${dialog} button')].find(button => button.textContent.trim() === 'Refresh options').disabled`,
                        ),
                        true,
                        "refresh cannot invalidate the admitted request after a lost response",
                    );
                    assert.equal(
                        await value(
                            page,
                            `document.querySelector('${dialog} input[value="follow-up:same-work"]').matches(':disabled')`,
                        ),
                        true,
                        "another role cannot discard an uncertain admission's recovery request",
                    );
                    await page.evaluate(
                        `document.querySelector('${dialog} input[value="follow-up:same-work"]').click()`,
                    );
                    await present(page, `${dialog} input[value="reviewer:same-work"]:checked`);
                    assert.equal(
                        app.sessions().length,
                        countBeforeHandoff + 1,
                        "the admitted request really created its destination",
                    );
                    await page.evaluate("window.handoffRejectNext = true");
                    await button(page, dialog, "Start review");
                    await until(
                        () => value<boolean>(page, "window.handoffRequests.length === 3"),
                        "an uncertain retry receives a later rejection",
                    );
                    await present(page, `${dialog} .error`);
                    assert.equal(
                        await value(
                            page,
                            `document.querySelector('${dialog} input[value="follow-up:same-work"]').matches(':disabled')`,
                        ),
                        true,
                        "a later rejection cannot disprove the original uncertain admission",
                    );
                    await button(page, dialog, "Start review");
                    await until(
                        () =>
                            value<boolean>(
                                page,
                                `Number(location.pathname.split('/').at(-1)) !== ${origin.id} && !document.querySelector(${JSON.stringify(dialog)})`,
                            ),
                        "retry navigates to the admitted successor",
                    );
                    const requestIds = await value<string[]>(
                        page,
                        "window.handoffRequests.map(request => request.requestId)",
                    );

                    assert.equal(requestIds.length, 4);
                    assert.notEqual(
                        requestIds[0],
                        requestIds[1],
                        "a definite rejection permits a fresh selection and admission",
                    );
                    assert.deepEqual(
                        requestIds.slice(1),
                        [requestIds[1], requestIds[1], requestIds[1]],
                        "uncertain retries preserve request identity even after a later rejection",
                    );
                    assert.equal(
                        await value(
                            page,
                            "window.handoffRequests.some(request => 'brief' in request)",
                        ),
                        false,
                        "humans activate the agent's brief, not author it in a form",
                    );
                    assert.equal(
                        app.sessions().length,
                        countBeforeHandoff + 1,
                        "retry has no duplicate destination",
                    );
                    const reviewer = app
                        .sessions()
                        .find((session) => session.threadType === "reviewer")!;

                    await present(page, ".topbar .title-sub .thread-type.reviewer");
                    const admitted = await app.handoffs.list(reviewer.id as ConversationId, user);

                    assert.ok(
                        admitted.handoffs.some((each) =>
                            each.brief.includes("Fixture tests passed; no known risks."),
                        ),
                        "successor receives the agent-authored brief",
                    );
                    await until(
                        () => app.sessions().every((session) => !session.busy),
                        "handoff delivery settles",
                    );
                    await app.commands.updateSession(reviewer.id as ConversationId, user, {
                        title: "独立 review matching member",
                    });
                    await app.commands.updateSession(originId, user, {
                        title: "Origin title follows its worker",
                    });
                    await app.commands.submit(originId, user, {
                        text: "held predecessor question",
                        requestId: `held-${viewport}`,
                    });
                    await until(
                        () =>
                            app.sessions().find((session) => session.id === origin.id)?.busy ===
                            true,
                        "predecessor questions still run",
                    );
                    await home(page);
                    const workItem = `${scope} [data-work-item-id="${reviewer.workItemId}"]`;

                    await present(page, workItem);
                    assert.equal(
                        await value(
                            page,
                            `(() => {
                            const button = document.querySelector(${JSON.stringify(`${workItem} .work-item-disclosure`)});
                            const chevron = button.querySelector('.work-item-chevron')?.getBoundingClientRect();
                            const role = button.querySelector('[role="img"]').getBoundingClientRect();
                            const target = button.getBoundingClientRect();

                            return Boolean(chevron && chevron.width > 0 && chevron.height > 0
                                && chevron.top >= role.bottom && chevron.bottom <= target.bottom
                                && Math.abs((chevron.left + chevron.width / 2) - (role.left + role.width / 2)) < 1);
                        })()`,
                        ),
                        true,
                        "visible disclosure chevron is centered below the stage icon",
                    );
                    assert.equal(
                        await value(
                            page,
                            `(() => { const meta = document.querySelector(${JSON.stringify(`${workItem} > .work-item-head .session-meta`)}); return meta.getBoundingClientRect().height <= parseFloat(getComputedStyle(meta).fontSize) * 2 && meta.scrollWidth <= meta.clientWidth; })()`,
                        ),
                        true,
                        "long path and model metadata occupy one bounded line",
                    );
                    assert.deepEqual(
                        await value(
                            page,
                            `[...document.querySelectorAll(${JSON.stringify(`${workItem} .work-item-member`)})].map(row => Number(row.dataset.id))`,
                        ),
                        [origin.id, reviewer.id],
                        "expanded stages follow admission order, origin first",
                    );
                    assert.equal(
                        await value(
                            page,
                            `document.querySelectorAll(${JSON.stringify(`${workItem} .work-item-member .session-meta .thread-type`)}).length`,
                        ),
                        0,
                        "sidebar role badges do not duplicate the leading stage icons",
                    );
                    assert.deepEqual(
                        await value(
                            page,
                            `[...document.querySelectorAll(${JSON.stringify(`${workItem} .work-item-member .session-state [role="img"]`)})].map(icon => icon.getAttribute('aria-label'))`,
                        ),
                        ["Worker", "Reviewer"],
                        "leading icons retain accessible stage labels",
                    );
                    assert.equal(
                        await value(
                            page,
                            `document.querySelector(${JSON.stringify(`${workItem} .work-item-disclosure [role="img"]`)}).getAttribute('aria-label')`,
                        ),
                        "Reviewer",
                        "Work Item icon follows its active reviewer",
                    );
                    await present(
                        page,
                        `${workItem} .work-item-member[data-id="${origin.id}"] .spinner`,
                    );
                    assert.equal(
                        await value(
                            page,
                            `document.querySelector(${JSON.stringify(`${workItem} > .work-item-head .spinner`)}) === null`,
                        ),
                        true,
                        "parent running state follows the active writer, not a questioning predecessor",
                    );
                    release();
                    await until(
                        () => app.sessions().every((session) => !session.busy),
                        "predecessor question settles",
                    );
                    assert.equal(
                        await value(
                            page,
                            `document.querySelectorAll(${JSON.stringify(`${scope} [data-work-item-id]`)}).length`,
                        ),
                        1,
                    );
                    await until(
                        () =>
                            value<boolean>(
                                page,
                                `document.querySelector(${JSON.stringify(`${workItem} > .work-item-head .session-title`)})?.textContent.trim() === 'Origin title follows its worker'`,
                            ),
                        "Work Item title tracks origin rename",
                    );
                    assert.equal(
                        await value(
                            page,
                            `document.querySelectorAll(${JSON.stringify(`${workItem} .work-item-member .session-move, ${workItem} .work-item-member [aria-label="Archive"]`)}).length`,
                        ),
                        0,
                        "members expose no independent move/archive action",
                    );
                    const memberRow = `${workItem} .work-item-member[data-id="${origin.id}"]`;

                    assert.equal(
                        await value(
                            page,
                            `document.querySelector(${JSON.stringify(`${memberRow} .session`)}).draggable`,
                        ),
                        false,
                        "member rows cannot start independent native moves",
                    );

                    if (viewport === "mobile") {
                        await page.evaluate(`const target = document.querySelector(${JSON.stringify(`${memberRow} .session`)});
                            target.scrollIntoView({ block: 'nearest', behavior: 'instant' });
                            await new Promise(resolve => setTimeout(resolve, 150));
                            const rect = target.getBoundingClientRect();
                            const touch = new Touch({ identifier: 71, target, clientX: rect.left + rect.width / 2, clientY: rect.top + rect.height / 2 });
                            window.memberContact = { target, touch };
                            target.dispatchEvent(new TouchEvent('touchstart', { bubbles: true, cancelable: true, touches: [touch], changedTouches: [touch] }));`);
                        await present(page, `${memberRow} .session-hold`);
                        assert.equal(
                            await value(
                                page,
                                `document.querySelector(${JSON.stringify(`${memberRow} .session-hold-choice.drag`)}).disabled`,
                            ),
                            true,
                            "member touch chooser disables Drag but retains Options",
                        );
                        await page.evaluate(`const { target, touch } = window.memberContact;
                            target.dispatchEvent(new TouchEvent('touchcancel', { bubbles: true, cancelable: true, touches: [], changedTouches: [touch] }));`);
                        await present(page, `${memberRow} .session-hold`, false);
                    }

                    await rowOptions(page, memberRow, viewport);
                    const memberActions = await value<string[]>(
                        page,
                        `[...document.querySelectorAll(${JSON.stringify(`${optionsSurface} .sidebar-option`)})].map(button => button.textContent.trim())`,
                    );

                    assert.equal(
                        memberActions.some((label) => /Move|Archive|Restore/.test(label)),
                        false,
                        "member context menus cannot expose independent organization actions",
                    );
                    assert.ok(
                        memberActions.includes("Rename…"),
                        "member context menus preserve main's non-organization actions",
                    );
                    await button(page, optionsSurface, "Work Item options…");
                    await until(
                        () =>
                            value<boolean>(
                                page,
                                `[...document.querySelectorAll(${JSON.stringify(`${optionsSurface} button`)})].some(button => button.textContent.trim() === 'Archive Work Item')`,
                            ),
                        "member options lead to explicit whole-item actions",
                    );
                    await page.evaluate(
                        `document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true }))`,
                    );
                    await present(page, optionsSurface, false);
                    await fill(page, `${scope} .search input`, "独立");
                    await present(page, workItem);
                    assert.equal(
                        await value(
                            page,
                            `document.querySelectorAll(${JSON.stringify(`${scope} [data-work-item-id]`)}).length`,
                        ),
                        1,
                        "a member match keeps exactly one parent",
                    );
                    assert.equal(
                        await value(
                            page,
                            `document.querySelectorAll(${JSON.stringify(`${workItem} .work-item-member`)}).length`,
                        ),
                        2,
                        "matching retains its same-work siblings",
                    );
                    await fill(page, `${scope} .search input`, "");
                    await button(page, `${scope} .session-tabs`, "Recent");
                    assert.equal(
                        await value(
                            page,
                            `document.querySelectorAll(${JSON.stringify(`${scope} [data-work-item-id]`)}).length`,
                        ),
                        1,
                        "Recent does not repeat individual members",
                    );
                    const beforeCollapse = await value(page, "location.href");

                    await click(page, `${workItem} .work-item-disclosure`);
                    await present(page, `${workItem} .work-item-member`, false);
                    assert.equal(
                        await value(page, "location.href"),
                        beforeCollapse,
                        "disclosure does not navigate",
                    );
                    assert.equal(
                        await value(
                            page,
                            `document.querySelector(${JSON.stringify(`${workItem} .work-item-disclosure`)}).getAttribute('aria-expanded')`,
                        ),
                        "false",
                    );
                    await page.evaluate(
                        `document.querySelector(${JSON.stringify(`${workItem} .work-item-disclosure`)}).focus()`,
                    );
                    await page.press("Enter");
                    await present(page, `${workItem} .work-item-member`);
                    assert.equal(
                        await value(
                            page,
                            `document.querySelector(${JSON.stringify(`${workItem} .work-item-disclosure`)}).getAttribute('aria-expanded')`,
                        ),
                        "true",
                    );
                    await click(
                        page,
                        `${workItem} .work-item-member[data-id="${origin.id}"] .session`,
                    );
                    await present(page, '.composer [aria-label="Read-only workspace"]');
                    await present(page, ".workflow-notice", false);
                    await present(page, 'textarea[aria-label="Message Pi"]');
                    await present(page, ".topbar .handoff-button", false);
                    await click(page, '.composer [aria-label="Open active thread"]');
                    await until(
                        () => app.sessions().every((session) => !session.busy),
                        "reviewer idle",
                    );
                    await present(page, '.composer [aria-label="Workflow status"]');
                    assert.equal(
                        await value(
                            page,
                            "Boolean(document.querySelector('button[aria-label=\"Complete review\"]'))",
                        ),
                        false,
                        "review outcome is not a human form",
                    );
                    await defaultChoice(page, "follow-up");
                    await say(app, reviewer.id as ConversationId, "UI_REVIEW_READY");
                    await present(page, '.topbar .handoff-button[aria-label="Choose next thread"]');
                    const countBeforePicker = app.sessions().length;

                    await click(page, ".topbar .handoff-button");
                    await present(page, `${dialog} input[name="handoff-option"]`);
                    assert.deepEqual(
                        await value(
                            page,
                            `[...document.querySelectorAll(${JSON.stringify(`${dialog} input[name="handoff-option"]`)})].map(input => input.value).sort()`,
                        ),
                        [
                            "chat:same-work",
                            "follow-up:same-work",
                            "land:same-work",
                            "publish:same-work",
                            "pull:same-work",
                            "reviewer:same-work",
                            "worker:new-work",
                            "worker:same-work",
                        ],
                        "completed review keeps all roles visible rather than filtering the human's choices",
                    );
                    assert.equal(
                        await value(
                            page,
                            `${JSON.stringify(dialog)} && document.querySelectorAll(${JSON.stringify(`${dialog} textarea`)}).length`,
                        ),
                        0,
                        "activation sheet asks for no human brief or summary",
                    );
                    await button(page, dialog, "Cancel");
                    await present(page, dialog, false);
                    assert.equal(
                        app.sessions().length,
                        countBeforePicker,
                        "opening and cancelling a branching picker creates nothing",
                    );
                    await click(page, ".topbar .handoff-button");
                    await choose(page, "land");
                    await button(page, dialog, "Start land");
                    await present(page, ".topbar .title-sub .thread-type.land");
                    await until(
                        () => app.sessions().every((session) => !session.busy),
                        "land delivery idle",
                    );
                    const localLand = app
                        .sessions()
                        .find((session) => session.threadType === "land")!;

                    await say(app, localLand.id as ConversationId, "UI_LAND_READY");
                    await present(page, '.topbar .handoff-button[aria-label="Choose next thread"]');
                    const land = app.sessions().find((session) => session.threadType === "land")!;

                    assert.equal(
                        (await app.handoffs.list(land.id as ConversationId, user)).workflow
                            .readyForPublish,
                        true,
                    );
                    // Bare native /handoff opens the picker instead of reaching the model or making a thread.
                    const countBeforeSlash = app.sessions().length;

                    await fill(page, 'textarea[aria-label="Message Pi"]', "/handoff");
                    await click(page, ".composer .send");
                    await present(page, dialog);
                    assert.equal(app.sessions().length, countBeforeSlash);
                    await choose(page, "publish");
                    assert.equal(
                        await value(
                            page,
                            `document.querySelector(${JSON.stringify(`${dialog} .handoff-explanation`)})?.textContent.includes('Each action requires separate human approval')`,
                        ),
                        true,
                    );
                    await button(page, dialog, "Cancel");
                    await present(page, dialog, false);
                    await home(page);
                    await rowOptions(page, `${workItem} > .work-item-head`, viewport);
                    await button(page, optionsSurface, "Move Work Item to project or goal…");
                    await select(page, '[role="dialog"] [aria-label="Project"]', "");
                    await button(page, '[role="dialog"]', "Move");
                    await until(
                        () =>
                            app
                                .sessions()
                                .filter((session) => session.id !== chat.id)
                                .every((session) => session.projectId === undefined),
                        "all Work Item members move together",
                    );
                    await present(page, '[role="dialog"]', false);
                    await rowOptions(page, `${workItem} > .work-item-head`, viewport);
                    await button(page, optionsSurface, "Archive Work Item");
                    await until(
                        () =>
                            app
                                .sessions()
                                .filter((session) => session.id !== chat.id)
                                .every((session) => session.archived),
                        "all Work Item members archive together",
                    );
                    await button(page, `${scope} .session-tabs`, "Archived");
                    await present(page, workItem);
                    assert.equal(
                        await value(
                            page,
                            `document.querySelectorAll(${JSON.stringify(`${scope} [data-work-item-id]`)}).length`,
                        ),
                        1,
                        "archive shows only one group",
                    );
                    await rowOptions(page, `${workItem} > .work-item-head`, viewport);
                    await button(page, optionsSurface, "Restore Work Item");
                    await until(
                        () =>
                            app
                                .sessions()
                                .filter((session) => session.id !== chat.id)
                                .every((session) => !session.archived),
                        "all Work Item members restore together",
                    );
                    await button(page, `${scope} .session-tabs`, "Recent");
                    await click(page, `${workItem} > .work-item-head .session`);
                    await present(page, '.topbar .handoff-button[aria-label="Choose next thread"]');
                    await click(page, ".topbar .handoff-button");
                    await choose(page, "publish");
                    await button(page, dialog, "Start publish");
                    await present(page, ".topbar .title-sub .thread-type.publish");
                    await until(
                        () => app.sessions().every((session) => !session.busy),
                        "publish fixture delivery idle",
                    );
                    const publication = app
                        .sessions()
                        .find((session) => session.threadType === "publish")!;

                    const publishing = say(
                        app,
                        publication.id as ConversationId,
                        "UI_APPROVED_PUBLISH",
                    );

                    await present(page, ".approval");
                    await button(page, ".approval-actions", "Allow");
                    await publishing;
                    await say(app, publication.id as ConversationId, "UI_PUBLISH_DONE");
                    assert.equal(
                        (await app.handoffs.list(publication.id as ConversationId, user)).workflow
                            .status,
                        "published",
                        "the agent records publication completion without a human form",
                    );
                    await present(page, '[role="dialog"]', false);
                    await defaultChoice(page, "worker");
                    await fill(page, 'textarea[aria-label="Message Pi"]', "/handoff worker --new");
                    await click(page, ".composer .send");
                    await present(page, ".topbar .title-sub .thread-type.worker");
                    const newWorkerId = await value<number>(
                        page,
                        "Number(location.pathname.split('/').at(-1))",
                    );
                    const newWorker = app.sessions().find((session) => session.id === newWorkerId)!;

                    assert.notEqual(
                        newWorker.workItemId,
                        reviewer.workItemId,
                        "new work creates a separate linked item",
                    );
                    await click(page, '.composer [aria-label="Previous Work Item"]');
                    await present(page, ".topbar .title-sub .thread-type.publish");
                    await home(page);
                    assert.equal(
                        await value(
                            page,
                            `document.querySelectorAll(${JSON.stringify(`${scope} [data-work-item-id]`)}).length`,
                        ),
                        2,
                        "new work does not join its landed predecessor's group",
                    );
                    const nextItem = `${scope} [data-work-item-id="${newWorker.workItemId}"]`;

                    await click(page, `${nextItem} > .work-item-head .session`);
                    await until(
                        () => app.sessions().every((session) => !session.busy),
                        "new work delivery idle",
                    );
                    await fill(page, 'textarea[aria-label="Message Pi"]', "/handoff worker --same");
                    await click(page, ".composer .send");
                    await until(
                        () =>
                            value<boolean>(
                                page,
                                `Number(location.pathname.split('/').at(-1)) !== ${newWorkerId}`,
                            ),
                        "same-work fresh worker opens",
                    );
                    await home(page);
                    await present(page, nextItem);
                    assert.equal(
                        await value(
                            page,
                            `document.querySelectorAll(${JSON.stringify(`${nextItem} .work-item-member`)}).length`,
                        ),
                        2,
                        "fresh same-work workers remain in the existing item",
                    );
                    assert.equal(
                        await value(
                            page,
                            `document.querySelectorAll(${JSON.stringify(`${scope} [data-work-item-id]`)}).length`,
                        ),
                        2,
                        "same-work followup does not duplicate the group",
                    );
                    await click(page, `${nextItem} > .work-item-head .session`);
                    await until(
                        () => app.sessions().every((session) => !session.busy),
                        "fresh worker delivery idle",
                    );
                    await click(page, ".topbar .handoff-button");
                    await choose(page, "follow-up");
                    assert.equal(
                        await value(
                            page,
                            `document.querySelector('${dialog} .handoff-explanation').textContent.includes('self-review')`,
                        ),
                        true,
                        "Follow-up explains its bounded fixes and self-review",
                    );
                    await button(page, dialog, "Start follow-up");
                    await present(page, ".topbar .title-sub .thread-type.follow-up");
                    await until(
                        () => app.sessions().every((session) => !session.busy),
                        "follow-up delivery idle",
                    );
                    await defaultChoice(page, "worker");
                    const followUpId = await value<number>(
                        page,
                        "Number(location.pathname.split('/').at(-1))",
                    );

                    await say(app, followUpId as ConversationId, "UI_FOLLOW_UP_READY");
                    await defaultChoice(page, "land");
                    await fill(page, 'textarea[aria-label="Message Pi"]', "/handoff pull");
                    await click(page, ".composer .send");
                    await present(page, ".topbar .title-sub .thread-type.pull");
                    assert.equal(
                        await value(
                            page,
                            "document.querySelector('.topbar .title-sub .thread-type').textContent.trim()",
                        ),
                        "Pull",
                        "Pull has its own labeled header instead of falling back to Worker",
                    );
                    await home(page);
                    await present(page, nextItem);
                    assert.deepEqual(
                        await value(
                            page,
                            `[...document.querySelectorAll(${JSON.stringify(`${nextItem} .work-item-member .session-state [role="img"]`)})].map(icon => icon.getAttribute('aria-label'))`,
                        ),
                        ["Worker", "Worker", "Follow-up", "Pull"],
                        "new roles keep their accessible sidebar indicators in the same Work Item",
                    );
                    assert.equal(
                        await value(page, "document.documentElement.scrollWidth <= innerWidth"),
                        true,
                        "390px layout never overflows horizontally",
                    );
                } finally {
                    release();
                    releaseBusy();
                    await browsers.closeAll({ final: true });
                    await app.close();
                    await new Promise<void>((resolve) => server.close(() => resolve()));
                }
            });
        }
    },
);
