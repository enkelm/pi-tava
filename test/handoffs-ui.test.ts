// Browser owner: explicit human choice, summary-in-flight rendering, stale chooser loads,
// uncertain HTTP recovery, destination naming/navigation and indivisible Work Item controls.
// Backend tests own state admission and durable summaries. No agent readiness/recommendation UI remains.
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
import { fauxAssistantMessage } from "@earendil-works/pi-ai/providers/faux";
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
        field.value = ${JSON.stringify(text)};
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

async function choices(page: BrowserPage) {
    await present(page, `${dialog} input[name="handoff-option"]`);

    return value<string[]>(
        page,
        `[...document.querySelectorAll('${dialog} input[name="handoff-option"]')].map(input => input.value).sort()`,
    );
}

async function choose(page: BrowserPage, type: string, relationship = "same-work") {
    await click(page, `${dialog} input[value="${type}:${relationship}"]`);
}

test(
    "Handoffs UI: human choices, summary preparation, durable retry, named successors and whole Work Items",
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

                let releaseSummary = () => {};

                let summaryGate: Promise<void> | undefined;
                let summaries = 0;
                let titleRequests = 0;
                const receivedSummary =
                    "Original ask: repair durable retry delivery. Files: handoffs.ts. Tests: fixture lifecycle passed. Deferred: hardware browser checks. Limits: no commit, push or restart.";
                const namedTitle = "Durable retry delivery";
                const model = scriptedModel(async (request, options) => {
                    const last = lastText(request as never);

                    if (last.role === "user" && last.text.startsWith(TITLE_PROMPT)) {
                        titleRequests++;
                        assert.ok(
                            last.text.includes(receivedSummary),
                            "destination naming sees the received source summary",
                        );

                        return fauxAssistantMessage(namedTitle);
                    }

                    if (
                        last.role === "user" &&
                        /^(?:\[from:[^\]]+\]\s*)?The human has requested a /.test(last.text)
                    ) {
                        summaries++;

                        if (summaryGate !== undefined) {
                            await Promise.race([
                                summaryGate,
                                new Promise<void>((resolve) =>
                                    options?.signal?.addEventListener("abort", () => resolve(), {
                                        once: true,
                                    }),
                                ),
                            ]);
                        }

                        return fauxAssistantMessage(receivedSummary);
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
                    await click(page, ".topbar .handoff-button");
                    assert.deepEqual(
                        await choices(page),
                        [
                            "pull:new-work",
                            "pull:same-work",
                            "researcher:new-work",
                            "researcher:same-work",
                            "worker:new-work",
                        ],
                        "unavailable stages are absent, not disabled milestone choices",
                    );
                    assert.equal(
                        await value(
                            page,
                            `document.querySelectorAll('${dialog} input:checked').length`,
                        ),
                        0,
                        "server ordering never silently selects a role for the human",
                    );
                    assert.equal(
                        await value(
                            page,
                            `document.querySelector('${dialog} button[type="submit"]').disabled`,
                        ),
                        true,
                    );
                    assert.equal(
                        await value(
                            page,
                            `Boolean(document.querySelector('${dialog} .handoff-recommendation, ${dialog} section[aria-label="Review and validation"], ${dialog} fieldset[aria-label="Validation risk acceptance"], ${dialog} textarea'))`,
                        ),
                        false,
                        "no agent recommendation, validation gate panel or authored-brief form",
                    );
                    assert.equal(summaries, 0, "opening the chooser never asks for a summary");
                    const countBefore = app.sessions().length;

                    await button(page, dialog, "Cancel");
                    await present(page, dialog, false);
                    assert.equal(app.sessions().length, countBefore);
                    writeFileSync(join(cwd, "fixture.txt"), "Actual changed file to review\n");
                    await click(page, ".topbar .handoff-button");
                    assert.ok(
                        (await choices(page)).includes("reviewer:same-work"),
                        "real Changes can offer review before any completed assistant report",
                    );
                    await choose(page, "reviewer");

                    // Keep an old options response in flight across close/reopen. A stale opening must
                    // not overwrite a fresh human selection, whether its response succeeds or fails.
                    await page.evaluate(`const fetchBeforeReopen = window.fetch.bind(window);
                        let delayed = false;
                        window.reopenLoads = 0;
                        window.fetch = async (url, options) => {
                            const response = await fetchBeforeReopen(url, options);

                            if (String(url).endsWith('/handoffs') && options?.method !== 'POST') {
                                window.reopenLoads++;

                                if (!delayed) {
                                    delayed = true;
                                    await new Promise(resolve => { window.releaseOldOptions = resolve; });
                                }
                            }

                            return response;
                        };
                        [...document.querySelectorAll('${dialog} button')].find(button => button.textContent.trim() === 'Refresh options').click();`);
                    await until(
                        () =>
                            value<boolean>(page, "typeof window.releaseOldOptions === 'function'"),
                        "old options load is held",
                    );
                    await click(page, `${dialog} .sheet-head [aria-label="Close"]`);
                    await click(page, ".topbar .handoff-button");
                    await choices(page);
                    await choose(page, "pull");
                    await page.evaluate(
                        "window.releaseOldOptions(); await new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)));",
                    );
                    await present(page, `${dialog} input[value="pull:same-work"]:checked`);
                    await button(page, dialog, "Cancel");

                    // Lose the real admitted POST response. A later denial cannot prove the first
                    // request failed, so role/payload/request identity must remain frozen for recovery.
                    await page.evaluate(`const fetchOriginal = window.fetch.bind(window);
                        window.handoffRequests = [];
                        window.handoffRejectNext = true;
                        window.handoffLoseNext = true;
                        window.fetch = async (url, options) => {
                            const match = /\\/api\\/c\\/\\d+\\/handoffs$/.test(String(url)) && options?.method === 'POST';

                            if (match) {
                                window.handoffRequests.push(JSON.parse(options.body));

                                if (window.handoffRejectNext) {
                                    window.handoffRejectNext = false;

                                    return new Response(JSON.stringify({ error: 'Fixture helper still busy' }), { status: 409 });
                                }
                            }

                            const response = await fetchOriginal(url, options);

                            if (match && response.ok && window.handoffLoseNext) {
                                window.handoffLoseNext = false;
                                window.handoffRejectNext = true;

                                throw new Error('Fixture lost create response');
                            }

                            return response;
                        };`);
                    await click(page, ".topbar .handoff-button");
                    await choices(page);
                    await choose(page, "reviewer");
                    await button(page, dialog, "Start review");
                    await present(page, `${dialog} .error`);
                    assert.equal(
                        await value(
                            page,
                            `[...document.querySelectorAll('${dialog} button')].find(button => button.textContent.trim() === 'Refresh options').disabled`,
                        ),
                        false,
                        "a definite initial rejection still allows eligibility refresh",
                    );
                    assert.equal(app.sessions().length, countBefore);
                    await button(page, dialog, "Refresh options");
                    await choices(page);
                    await choose(page, "reviewer");
                    summaryGate = new Promise<void>((resolve) => {
                        releaseSummary = resolve;
                    });
                    await button(page, dialog, "Start review");
                    await until(() => summaries === 1, "human click requests source summary");
                    await present(page, `${dialog} form[aria-busy="true"]`);
                    assert.equal(
                        await value(
                            page,
                            `document.querySelector('${dialog} button[type="submit"]').textContent.trim()`,
                        ),
                        "Preparing summary…",
                    );
                    assert.equal(
                        await value(
                            page,
                            `[...document.querySelectorAll('${dialog} input[name="handoff-option"]')].every(input => input.matches(':disabled'))`,
                        ),
                        true,
                    );
                    assert.equal(
                        app.sessions().length,
                        countBefore,
                        "summary is not a provisional successor",
                    );
                    assert.equal(
                        await value(page, "Number(location.pathname.split('/').at(-1))"),
                        origin.id,
                    );
                    await shot(page, `${viewport}-preparing-summary`);
                    releaseSummary();
                    summaryGate = undefined;
                    await present(page, `${dialog} .error`);
                    await until(
                        () => app.sessions().length === countBefore + 1,
                        "real admitted successor exists despite lost response",
                    );
                    assert.equal(
                        await value(
                            page,
                            `document.querySelector('${dialog} input[value="pull:same-work"]').matches(':disabled')`,
                        ),
                        true,
                    );
                    assert.equal(
                        await value(
                            page,
                            `[...document.querySelectorAll('${dialog} button')].find(button => button.textContent.trim() === 'Refresh options').disabled`,
                        ),
                        true,
                    );
                    await until(
                        () => value<boolean>(page, "window.handoffRequests.length === 3"),
                        "automatic recovery receives a refusal after the uncertain admission",
                    );
                    await present(page, `${dialog} .error`);
                    assert.equal(
                        await value(
                            page,
                            `document.querySelector('${dialog} input[value="pull:same-work"]').matches(':disabled')`,
                        ),
                        true,
                        "later refusal does not discard the original uncertain request",
                    );
                    await button(page, dialog, "Start review");
                    await present(page, ".topbar .title-sub .thread-type.reviewer");
                    await present(page, dialog, false);
                    const ids = await value<string[]>(
                        page,
                        "window.handoffRequests.map(request => request.requestId)",
                    );

                    assert.equal(ids.length, 4);
                    assert.notEqual(ids[0], ids[1]);
                    assert.deepEqual(ids.slice(1), [ids[1], ids[1], ids[1]]);
                    assert.deepEqual(
                        await value(
                            page,
                            "window.handoffRequests.map(request => request.recoverOnly)",
                        ),
                        [false, false, true, false],
                        "automatic recovery is read-only; only explicit human taps may restart a failed summary",
                    );
                    assert.equal(
                        await value(
                            page,
                            "window.handoffRequests.some(request => 'brief' in request)",
                        ),
                        false,
                    );
                    assert.equal(app.sessions().length, countBefore + 1);
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
                        "successor title generated from received summary",
                    );
                    assert.equal(summaries, 1);
                    assert.equal(titleRequests, 1);
                    assert.ok(
                        (await app.handoffs.list(reviewerId, user)).handoffs.some((record) =>
                            record.brief.includes(receivedSummary),
                        ),
                    );
                    await app.commands.updateSession(reviewerId, user, {
                        title: "独立 review matching member",
                    });
                    await app.commands.updateSession(originId, user, {
                        title: "Origin title follows its worker",
                    });
                    await home(page);
                    const workItem = `${scope} [data-work-item-id="${reviewer.workItemId}"]`;

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
                        "role indicators do not duplicate leading accessible stage icons",
                    );
                    assert.equal(
                        await value(
                            page,
                            `document.querySelectorAll(${JSON.stringify(`${workItem} .work-item-member .session-move, ${workItem} .work-item-member [aria-label="Archive"]`)}).length`,
                        ),
                        0,
                    );
                    const memberRow = `${workItem} .work-item-member[data-id="${origin.id}"]`;

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
                            `document.querySelectorAll(${JSON.stringify(`${scope} [data-work-item-id]`)}).length`,
                        ),
                        1,
                    );
                    assert.equal(
                        await value(
                            page,
                            `document.querySelectorAll(${JSON.stringify(`${workItem} .work-item-member`)}).length`,
                        ),
                        2,
                        "member search does not orphan its parent or hide siblings",
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
                    await present(page, ".topbar .handoff-button", false);
                    await present(page, 'textarea[aria-label="Message Pi"]');
                    await click(page, '.composer [aria-label="Open active thread"]');
                    await click(page, ".topbar .handoff-button");
                    assert.deepEqual(
                        await choices(page),
                        [
                            "follow-up:same-work",
                            "land:same-work",
                            "pull:new-work",
                            "pull:same-work",
                            "researcher:new-work",
                            "researcher:same-work",
                            "worker:new-work",
                            "worker:same-work",
                        ],
                        "review history offers Land without completion or validation forms",
                    );
                    await choose(page, "land");
                    await button(page, dialog, "Start land");
                    await present(page, ".topbar .title-sub .thread-type.land");
                    await until(
                        () => app.sessions().every((session) => !session.busy),
                        "Land delivery settles without model milestone calls",
                    );
                    await fill(page, 'textarea[aria-label="Message Pi"]', "/handoff");
                    await click(page, ".composer .send");
                    await present(page, dialog);
                    await choices(page);
                    await choose(page, "publish");
                    assert.match(
                        await value<string>(
                            page,
                            `document.querySelector('${dialog} .handoff-explanation').textContent`,
                        ),
                        /separate human approval/i,
                    );
                    await button(page, dialog, "Cancel");
                    await home(page);
                    await rowOptions(page, `${workItem} > .work-item-head`, viewport);
                    await button(page, optionsSurface, "Move Work Item to project or goal…");
                    await page.evaluate(
                        `const field = document.querySelector('[role="dialog"] [aria-label="Project"]'); field.value = ''; field.dispatchEvent(new Event('change', { bubbles: true }));`,
                    );
                    await button(page, '[role="dialog"]', "Move");
                    await until(
                        () => app.sessions().every((session) => session.projectId === undefined),
                        "all members move together",
                    );
                    await present(page, '[role="dialog"]', false);
                    await rowOptions(page, `${workItem} > .work-item-head`, viewport);
                    await button(page, optionsSurface, "Archive Work Item");
                    await until(
                        () => app.sessions().every((session) => session.archived),
                        "all members archive together",
                    );
                    await button(page, `${scope} .session-tabs`, "Archived");
                    await present(page, workItem);
                    await rowOptions(page, `${workItem} > .work-item-head`, viewport);
                    await button(page, optionsSurface, "Restore Work Item");
                    await until(
                        () => app.sessions().every((session) => !session.archived),
                        "all members restore together",
                    );
                    await button(page, `${scope} .session-tabs`, "Recent");
                    await click(page, `${workItem} > .work-item-head .session`);
                    await fill(page, 'textarea[aria-label="Message Pi"]', "/handoff publish");
                    await click(page, ".composer .send");
                    await present(page, ".topbar .title-sub .thread-type.publish");
                    await until(
                        () => app.sessions().every((session) => !session.busy),
                        "Publish delivery settles",
                    );
                    assert.equal(
                        (
                            await app.handoffs.list(
                                app.sessions().find((session) => session.threadType === "publish")!
                                    .id as ConversationId,
                                user,
                            )
                        ).workflow.status,
                        "active",
                        "Publish thread creation is not a publication receipt or completed external action",
                    );
                    await fill(page, 'textarea[aria-label="Message Pi"]', "/handoff worker --new");
                    await click(page, ".composer .send");
                    await present(page, ".topbar .title-sub .thread-type.worker");
                    await until(
                        () => app.sessions().every((session) => !session.busy),
                        "new Work Item delivery settles",
                    );
                    const newWorkerId = await value<number>(
                        page,
                        "Number(location.pathname.split('/').at(-1))",
                    );
                    const newWorker = app.sessions().find((session) => session.id === newWorkerId)!;

                    assert.notEqual(newWorker.workItemId, reviewer.workItemId);
                    await click(page, ".topbar .handoff-button");
                    const newChoices = await choices(page);

                    assert.equal(
                        newChoices.some((choice) =>
                            ["land:same-work", "follow-up:same-work", "worker:same-work"].includes(
                                choice,
                            ),
                        ),
                        false,
                        "new work cannot inherit review history or repeat its current same-work role",
                    );
                    await button(page, dialog, "Cancel");
                    await fill(page, 'textarea[aria-label="Message Pi"]', "/handoff researcher");
                    await click(page, ".composer .send");
                    await present(page, ".topbar .title-sub .thread-type.researcher");
                    await until(
                        () => app.sessions().every((session) => !session.busy),
                        "research delivery settles",
                    );
                    await fill(page, 'textarea[aria-label="Message Pi"]', "/handoff pull");
                    await click(page, ".composer .send");
                    await present(page, ".topbar .title-sub .thread-type.pull");
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
                    assert.deepEqual(
                        await value(
                            page,
                            `[...document.querySelectorAll(${JSON.stringify(`${nextItem} .work-item-member .session-state [role="img"]`)})].map(icon => icon.getAttribute('aria-label'))`,
                        ),
                        ["Worker", "Researcher", "Pull"],
                    );
                    assert.equal(
                        await value(page, "document.documentElement.scrollWidth <= innerWidth"),
                        true,
                        "mobile and desktop chooser/group layout does not overflow horizontally",
                    );
                    await shot(page, `${viewport}-human-controlled-work-items`);
                } finally {
                    releaseSummary();
                    await browsers.closeAll({ final: true });
                    await app.close();
                    server.closeAllConnections();
                    await new Promise<void>((resolve) => server.close(() => resolve()));
                }
            });
        }
    },
);
