// Authoring gate: browser activation, retry identity, native slash routing and group organization are public UI contracts.
// A lost create response must not create two successors; member search must not orphan or duplicate its Work Item.
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
    "Handoffs UI: agent-owned readiness, direct activation, durable retry and indivisible Work Items",
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

                    if (last.role === "user" && text.endsWith("UI_WORKER_READY")) {
                        return fauxAssistantMessage(
                            [
                                fauxToolCall("handoff", {
                                    action: "prepare",
                                    targetType: "reviewer",
                                    relationship: "same-work",
                                    brief: "Independently review this checkout. Fixture tests passed; no known risks.",
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
                    await present(page, '.topbar .handoff-button[aria-label="Start review"]');
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

                    await present(
                        page,
                        '.topbar .handoff-button[aria-label="Start review"]:not([disabled])',
                    );
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
                    window.fetch = async (url, options) => {
                        const match = /\\/api\\/c\\/\\d+\\/handoffs$/.test(String(url)) && options?.method === 'POST';

                        if (match) {
                            window.handoffRequests.push(JSON.parse(options.body));
                        }

                        const result = await fetchOriginal(url, options);

                        if (match && result.ok && window.handoffRequests.length === 1) {
                            throw new Error('Fixture lost create response');
                        }

                        return result;
                    };`);
                    await click(page, ".topbar .handoff-button");
                    await until(
                        () => value<boolean>(page, "window.handoffRequests.length === 1"),
                        "one Worker click activates review without a dialog",
                    );
                    await present(page, dialog, false);
                    await present(page, '.topbar .handoff-button[aria-label="Retry start review"]');
                    assert.equal(
                        app.sessions().length,
                        countBeforeHandoff + 1,
                        "the first request really created its destination",
                    );
                    await click(page, '.topbar .handoff-button[aria-label="Retry start review"]');
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

                    assert.equal(requestIds.length, 2);
                    assert.equal(requestIds[0], requestIds[1], "retries preserve request identity");
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
                    await say(app, reviewer.id as ConversationId, "UI_REVIEW_READY");
                    await present(page, '.topbar .handoff-button[aria-label="Start land"]');
                    const countBeforePicker = app.sessions().length;

                    await click(page, ".topbar .handoff-button");
                    await present(page, `${dialog} input[name="handoff-option"]`);
                    assert.deepEqual(
                        await value(
                            page,
                            `[...document.querySelectorAll(${JSON.stringify(`${dialog} input[name="handoff-option"]`)})].map(input => input.value).sort()`,
                        ),
                        ["land:same-work", "worker:same-work"],
                        "completed review exposes only valid Land/fresh Worker paths, not new-work/Publish/re-review choices",
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
                    await present(page, '.topbar .handoff-button[aria-label="Start publish"]');
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
                    await present(page, '.topbar .handoff-button[aria-label="Start publish"]');
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
                    assert.equal(
                        await value(page, "document.documentElement.scrollWidth <= innerWidth"),
                        true,
                        "390px layout never overflows horizontally",
                    );
                } finally {
                    release();
                    await browsers.closeAll({ final: true });
                    await app.close();
                    await new Promise<void>((resolve) => server.close(() => resolve()));
                }
            });
        }
    },
);
