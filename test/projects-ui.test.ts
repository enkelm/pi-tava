// Authoring gate: real UI choices must preserve project/goal membership and reach durable state.
// Regressions: orphan goals, lost creation/rename controls, labelled sidebar chips and stale peers.
// App tests own storage/access/migration; this owns browser disclosure, forms and event delivery.
// Uses public app APIs for two standalone fixtures; no test-only production seams or state flags.
import {
    type App,
    cleanUp,
    context,
    openApp,
    owner,
    root,
    scriptedModel,
    until,
    work,
} from "./helpers.ts";
import assert from "node:assert/strict";
import { mkdirSync, realpathSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import { join } from "node:path";
import { after, test } from "node:test";
import type { ConversationId } from "@earendil-works/pi-durable";
import { Browsers } from "../src/server/browser.ts";
import { findBrowser } from "../src/server/browser/discovery.ts";
import type { BrowserPage } from "../src/server/browser/page.ts";
import { VIEWPORTS } from "../src/server/browser/viewport.ts";
import { ProjectsDoc } from "../src/server/docs.ts";
import { createHandler } from "../src/server/http.ts";

const sessionDialog = '[role="dialog"][aria-label="New Session"]';
const panel = `${sessionDialog} #session-panel-new`;
const projectNameField = 'input[aria-label="Project name"]';
const projectPathField = 'input[aria-label="Default working directory"]';
const renameDialog = '[role="dialog"][aria-label="Rename goal"]';
const goalNameField = `${renameDialog} input[aria-label="Goal name"]`;

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
                    const bounds = element.getBoundingClientRect();

                    return bounds.width > 0 && bounds.height > 0;
                }) === ${expected}`,
            ),
        `${expected ? "show" : "hide"} ${selector}`,
        20_000,
    );
}

async function click(page: BrowserPage, selector: string) {
    await present(page, selector);
    await page.evaluate(`
        [...document.querySelectorAll(${JSON.stringify(selector)})]
            .find(element => element.getBoundingClientRect().width > 0).click();
    `);
}

async function button(page: BrowserPage, scope: string, text: string) {
    const expression = `[...document.querySelectorAll(${JSON.stringify(`${scope} button`)})]
        .find(element => element.textContent.trim() === ${JSON.stringify(text)}
            && element.getBoundingClientRect().width > 0)`;

    await until(() => value<boolean>(page, `Boolean(${expression})`), `${scope}: ${text}`);
    await page.evaluate(`(${expression}).click()`);
}

async function fill(page: BrowserPage, selector: string, text: string) {
    await present(page, selector);
    await page.evaluate(`
        const field = document.querySelector(${JSON.stringify(selector)});

        field.focus();
        field.value = ${JSON.stringify(text)};
        field.dispatchEvent(new InputEvent('input', { bubbles: true }));
    `);
    assert.equal(
        await value(page, `document.querySelector(${JSON.stringify(selector)}).value`),
        text,
    );
}

function group(scope: string, name: string, goal = false) {
    const selector = `${scope} ${goal ? ".goal-section" : ".project-section:not(.goal-section)"}`;

    return `[...document.querySelectorAll(${JSON.stringify(selector)})].find(section =>
        section.querySelector(':scope > .project-group-head .group-name')?.textContent.trim()
            === ${JSON.stringify(name)})`;
}

async function waitGroup(page: BrowserPage, scope: string, name: string, goal = false) {
    await until(
        () => value<boolean>(page, `Boolean(${group(scope, name, goal)})`),
        `${goal ? "goal" : "project"} ${name}`,
    );
}

async function groupClick(
    page: BrowserPage,
    scope: string,
    name: string,
    selector: string,
    goal = false,
) {
    await waitGroup(page, scope, name, goal);
    await page.evaluate(
        `(${group(scope, name, goal)}).querySelector(${JSON.stringify(selector)}).click()`,
    );
}

async function disclosure(
    page: BrowserPage,
    scope: string,
    name: string,
    expanded: boolean,
    goal = false,
) {
    await until(
        () =>
            value<boolean>(
                page,
                `(() => {
                    const section = ${group(scope, name, goal)};
                    const head = section.querySelector(':scope > .project-group-head .group-head');
                    const body = section.querySelector(':scope > .group-body');

                    return head.getAttribute('aria-expanded') === '${expanded}'
                        && body.inert === ${!expanded}
                        && ${expanded ? "body.getBoundingClientRect().height > 0" : "body.getBoundingClientRect().height < 1"};
                })()`,
            ),
        `${name} ${expanded ? "reveals" : "hides"} its own thread list`,
    );
}

async function tab(page: BrowserPage, scope: string, text: string) {
    await button(page, `${scope} .session-tabs:not(.private-tabs)`, text);
    await until(
        () =>
            value<boolean>(
                page,
                `document.querySelector(${JSON.stringify(`${scope} .session-tabs:not(.private-tabs) [aria-selected=true]`)})?.textContent.trim() === ${JSON.stringify(text)}`,
            ),
        `${text} tab selected`,
    );
}

async function closeDialog(page: BrowserPage) {
    // Close the existing sheet through its public action; all creation still goes through rendered forms.
    await page.evaluate(`(await import('/store.js')).closeSheet()`);
    await present(page, '[role="dialog"]', false);
}

async function home(page: BrowserPage, scope: string) {
    if (scope.startsWith(".home-list")) {
        await click(page, '[aria-label="Back to sessions"]');
    }

    // Desktop keeps its real sidebar beside the conversation; its Back control is mobile-only.
    await present(page, `${scope} .new-button[aria-label="New session"]`);
}

async function chooseProject(page: BrowserPage, name: string) {
    await button(page, `${panel} .project-choices`, name);
    await present(
        page,
        `${panel} [role="group"][aria-label=${JSON.stringify(`Goals in ${name}`)}]`,
    );
}

async function destination(page: BrowserPage, cwd: string) {
    assert.equal(
        await value(page, `document.querySelector('${panel} .session-path .mono').title`),
        cwd,
        "new sessions display the project's default cwd, not the open thread's cwd",
    );
}

async function start(page: BrowserPage, app: App, type: "Worker" | "Chat") {
    const before = new Set(app.sessions().map((session) => session.id));

    await button(page, panel, `Start ${type}`);
    await until(
        () =>
            value<boolean>(
                page,
                `/^\\/s\\/\\d+$/.test(location.pathname) && document.querySelector('${sessionDialog}') === null`,
            ),
        `submitted ${type} opens its conversation`,
    );
    const created = app.sessions().filter((session) => !before.has(session.id));

    assert.equal(created.length, 1, "one submit creates exactly one session");
    assert.equal(await value(page, "Number(location.pathname.split('/').at(-1))"), created[0]!.id);
    await present(page, ".topbar .title-sub .thread-type");
    assert.equal(
        await value(
            page,
            "document.querySelector('.topbar .title-sub .thread-type').textContent.trim()",
        ),
        type,
        "the conversation header keeps its labelled thread type",
    );
    assert.equal(
        await value(
            page,
            `(() => {
                const subtitle = document.querySelector('.topbar .title-sub');
                const chip = subtitle.querySelector('.thread-type').getBoundingClientRect();
                const path = subtitle.querySelector('.title-sub-text').getBoundingClientRect();

                return path.left > chip.right;
            })()`,
        ),
        true,
        "the header leaves a visible gap between the thread chip and working directory",
    );

    return created[0]!;
}

async function rowTag(page: BrowserPage, scope: string, id: number, type: "Chat" | "Worker") {
    const row = `${scope} .session-row[data-id="${id}"]`;

    await present(page, row);
    const result = await value<{
        text: string;
        label: string;
        title: string;
        icon: boolean;
        decorated: boolean;
        duplicate: boolean;
        idleOnRight: boolean;
        ordinary: boolean;
        color: boolean;
    }>(
        page,
        `(() => {
            const row = document.querySelector(${JSON.stringify(row)});
            const tag = row.querySelector('.session-state .thread-type');
            const icon = tag.querySelector('svg')?.getBoundingClientRect();
            const style = getComputedStyle(tag);
            const swatch = document.createElement('span');

            swatch.style.color = 'var(${type === "Chat" ? "--o-green" : "--o-blue"})';
            row.append(swatch);
            const color = getComputedStyle(tag).color === getComputedStyle(swatch).color;

            swatch.remove();

            return {
                text: tag.textContent.trim(),
                label: tag.getAttribute('aria-label'),
                title: tag.title,
                icon: Boolean(icon?.width > 0 && icon?.height > 0),
                decorated: parseFloat(style.borderTopWidth) > 0
                    || style.backgroundColor !== 'rgba(0, 0, 0, 0)',
                duplicate: row.querySelector('.session-meta .thread-type') !== null,
                idleOnRight: row.querySelector('.session-side .state-idle') !== null,
                ordinary: row.closest('.project-section') === null,
                color,
            };
        })()`,
    );

    assert.equal(result.text, "", "sidebar thread chips are icon-only");
    assert.equal(result.label, type, "the icon retains an accessible thread type");
    assert.equal(result.title, type, "the icon retains its thread-type tooltip");
    assert.equal(result.icon, true, "the leading thread type renders a visible icon");
    assert.equal(result.decorated, false, "sidebar type icons have no border or background");
    assert.equal(result.duplicate, false, "thread type no longer crowds the path metadata");
    assert.equal(result.idleOnRight, true, "the idle state marker moves to the right side");
    assert.equal(
        result.color,
        true,
        `${type} uses its ${type === "Chat" ? "green" : "blue"} theme color`,
    );

    return result.ordinary;
}

async function shot(page: BrowserPage, name: string) {
    const directory = process.env.PROJECTS_SCREENSHOT_DIR;

    if (directory === undefined) {
        return;
    }

    mkdirSync(directory, { recursive: true });
    const captured = await page.screenshot();

    writeFileSync(join(directory, `${name}.jpg`), Buffer.from(captured.data, "base64"));
}

test(
    "Projects UI: creation, goal renaming, typed chips, independent folds and live bulk actions",
    { skip: findBrowser() === undefined ? "no Chromium installed" : false, timeout: 180_000 },
    async (t) => {
        for (const viewport of ["mobile", "desktop"] as const) {
            await t.test(viewport, async () => {
                const folder = join(work, `projects-${viewport}`);
                const overrideFolder = join(work, `override-${viewport}`);

                mkdirSync(folder);
                mkdirSync(overrideFolder);
                const cwd = realpathSync(folder);
                const override = realpathSync(overrideFolder);
                const model = scriptedModel();
                const app = await openApp(model, join(root, `projects-${viewport}-data`));
                const user = owner(app);
                // Standalone Workers represent existing Collab rows; migration itself is owned by app tests.
                const standaloneWorker = await app.commands.createSession(user, {
                    cwd,
                    title: "Existing Collab work",
                    threadType: "worker",
                });
                const standaloneChat = await app.commands.createSession(user, {
                    cwd,
                    title: "Unrelated Chat in the same folder",
                });
                const server = createServer(
                    createHandler({
                        app,
                        listen: { host: "127.0.0.1", port: 0 },
                        restart: () => {},
                    }),
                );
                const browsers = new Browsers({
                    dataDir: join(root, `projects-${viewport}-browser`),
                    load: async () => undefined,
                    save: () => {},
                });

                await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
                const base = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
                const scope = viewport === "mobile" ? ".home-list .sessions" : ".sidebar .sessions";
                const initialName = `Build ${viewport}`;
                const name = `Workbench ${viewport}`;

                try {
                    const page = await browsers.open(1);
                    const peer = await browsers.open(2);

                    for (const connected of [page, peer]) {
                        await connected.setViewport(VIEWPORTS[viewport]);
                        await connected.navigate(
                            `${base}/login?token=${encodeURIComponent(app.config.ownerToken)}`,
                        );
                        await present(connected, `${scope} .new-button[aria-label="New session"]`);
                        await until(
                            () =>
                                value<boolean>(
                                    connected,
                                    `document.querySelector('${scope} .session-tabs:not(.private-tabs) [aria-selected=true]')?.textContent.trim() === 'Projects'`,
                                ),
                            "Projects is the first/default view on a clean browser",
                        );
                        assert.equal(
                            await value(
                                connected,
                                `document.querySelector('${scope} .session-tabs:not(.private-tabs) [role=tab]')?.textContent.trim()`,
                            ),
                            "Projects",
                        );
                        assert.equal(
                            await rowTag(connected, scope, standaloneWorker.id, "Worker"),
                            true,
                        );
                        assert.equal(
                            await rowTag(connected, scope, standaloneChat.id, "Chat"),
                            true,
                        );
                    }

                    assert.equal(
                        await value(
                            page,
                            `[...document.querySelectorAll('${scope} button')]
                                .some(button => button.textContent.trim() === 'New Project')`,
                        ),
                        false,
                        "the sidebar has no standalone New Project button",
                    );
                    await click(page, `${scope} .new-button[aria-label="New session"]`);
                    await present(page, panel);
                    await fill(page, `${panel} ${projectNameField}`, initialName);
                    await fill(page, `${panel} ${projectPathField}`, cwd);
                    await button(page, `${panel} .project-form`, "Create project");
                    await chooseProject(page, initialName);
                    await closeDialog(page);
                    const project = app.projects
                        .list(user)
                        .projects.find((item) => item.name === initialName);

                    assert.ok(project, "the real project form persisted a project");
                    assert.equal(project.cwd, cwd);
                    await waitGroup(peer, scope, initialName);
                    await groupClick(
                        page,
                        scope,
                        initialName,
                        `[aria-label=${JSON.stringify(`Edit ${initialName}`)}]`,
                    );
                    await fill(page, projectNameField, name);
                    await button(page, ".project-form", "Save project");
                    await present(page, '[role="dialog"]', false);
                    await waitGroup(page, scope, name);
                    await waitGroup(peer, scope, name);
                    assert.equal(
                        await value(
                            page,
                            `(() => {
                                const head = (${group(scope, name)}).querySelector('.group-head');
                                const chevron = head.querySelector('.group-disclosure').getBoundingClientRect();
                                const label = head.querySelector('.group-name').getBoundingClientRect();

                                return head.querySelectorAll('svg').length === 1
                                    && chevron.right <= label.left;
                            })()`,
                        ),
                        true,
                        "projects use one leading disclosure icon, not a folder and trailing chevron",
                    );
                    assert.equal(
                        await value(
                            page,
                            `[${standaloneWorker.id}, ${standaloneChat.id}].every(id =>
                                Boolean((${group(scope, name)}).compareDocumentPosition(
                                    document.querySelector('${scope} .session-row[data-id="' + id + '"]'),
                                ) & Node.DOCUMENT_POSITION_FOLLOWING))`,
                        ),
                        true,
                        "ordinary standalone rows follow the project sections",
                    );

                    await click(page, `${scope} .new-button[aria-label="New session"]`);
                    await present(page, panel);
                    await button(page, panel, "New Project");
                    await present(page, `${panel} .project-form`);
                    await button(page, `${panel} .project-form`, "Cancel");
                    await chooseProject(page, name);
                    assert.equal(
                        await value(
                            page,
                            `document.querySelector('${panel} .project-goal-choices button')?.textContent.trim()`,
                        ),
                        "New Goal",
                        "+ New Goal is the first goal choice",
                    );
                    await button(page, `${panel} .project-goal-choices`, "New Goal");
                    assert.equal(
                        await value(
                            page,
                            `document.querySelector('${panel} input:not([type=checkbox]), ${panel} textarea') === null`,
                        ),
                        true,
                        "selecting New Goal never asks for a goal name",
                    );
                    assert.equal(
                        app.projects.list(user).goals.length,
                        0,
                        "selection does not create a goal",
                    );
                    await destination(page, cwd);
                    await closeDialog(page);
                    assert.equal(
                        app.projects.list(user).goals.length,
                        0,
                        "cancelling leaves no orphan goal",
                    );
                    assert.equal(app.sessions().length, 2);

                    await click(page, `${scope} .new-button[aria-label="New session"]`);
                    await chooseProject(page, name);
                    await button(page, `${panel} .project-goal-choices`, "New Goal");
                    const first = await start(page, app, "Worker");
                    const createdGoal = app.projects
                        .list(user)
                        .goals.find((item) => item.id === first.goalId);

                    assert.ok(createdGoal, "session submission creates its goal");
                    let goal = createdGoal;

                    assert.equal(app.projects.list(user).goals.length, 1);
                    assert.equal(first.projectId, project.id);
                    assert.equal(first.cwd, cwd);
                    assert.equal(first.threadType, "worker");
                    await home(page, scope);
                    await waitGroup(page, scope, goal.name, true);
                    await waitGroup(peer, scope, goal.name, true);
                    assert.equal(
                        await value(
                            page,
                            `(${group(scope, goal.name, true)}).querySelector('.session-row')?.dataset.id`,
                        ),
                        String(first.id),
                        "even one Worker retains a distinct goal section with its session",
                    );
                    assert.equal(
                        await value(
                            page,
                            `Boolean((${group(scope, goal.name, true)}).querySelector(':scope > .project-group-head .group-symbol path')?.getAttribute('d'))`,
                        ),
                        true,
                        "the single-thread goal retains its goal icon",
                    );
                    assert.equal(await rowTag(page, scope, first.id, "Worker"), false);
                    assert.equal(
                        await rowTag(page, scope, standaloneChat.id, "Chat"),
                        true,
                        "sharing a cwd never assigns a standalone Chat to the project",
                    );

                    const renameControl = `[aria-label=${JSON.stringify(`Rename goal ${goal.name}`)}]`;

                    await groupClick(page, scope, goal.name, renameControl, true);
                    await present(page, renameDialog);
                    assert.equal(
                        await value(page, `document.querySelector('${goalNameField}').value`),
                        goal.name,
                        "rename starts with the current goal name",
                    );
                    assert.equal(
                        await value(page, `document.querySelector('${goalNameField}').maxLength`),
                        160,
                        "goal name entry is bounded",
                    );
                    await fill(page, goalNameField, "   ");
                    assert.equal(
                        await value(
                            page,
                            `[...document.querySelectorAll('${renameDialog} button')]
                                .find(button => button.textContent.trim() === 'Save').disabled`,
                        ),
                        true,
                        "a whitespace-only goal name cannot be saved",
                    );
                    await fill(page, goalNameField, "Discard this rename");
                    await button(page, renameDialog, "Cancel");
                    await present(page, renameDialog, false);
                    assert.deepEqual(
                        app.projects.list(user).goals.find((item) => item.id === goal.id),
                        goal,
                        "cancel leaves the goal unchanged",
                    );
                    await waitGroup(peer, scope, goal.name, true);

                    const renamedGoal = `Deliver ${viewport}`;

                    await groupClick(page, scope, goal.name, renameControl, true);
                    await fill(page, goalNameField, `  ${renamedGoal}  `);
                    await button(page, renameDialog, "Save");
                    await present(page, renameDialog, false);
                    await waitGroup(page, scope, renamedGoal, true);
                    await waitGroup(peer, scope, renamedGoal, true);
                    assert.equal(
                        (await app.harness.snapshot(ProjectsDoc, context))?.goals[goal.id]?.name,
                        renamedGoal,
                        "the trimmed UI rename reaches durable state and the untouched peer",
                    );
                    const savedGoal = app.projects
                        .list(user)
                        .goals.find((item) => item.id === first.goalId);

                    assert.ok(savedGoal);
                    goal = savedGoal;

                    await groupClick(
                        page,
                        scope,
                        goal.name,
                        `[aria-label=${JSON.stringify(`New Session in ${goal.name}`)}]`,
                        true,
                    );
                    await present(page, `${panel} .session-destination`);
                    await destination(page, cwd);
                    assert.equal(
                        await value(
                            page,
                            `document.querySelector('${panel} .project-goal-choices [aria-pressed=true]')?.textContent.trim()`,
                        ),
                        goal.name,
                        "goal + preselects its project and goal",
                    );
                    await button(page, `${panel} .session-path`, "Change");
                    await present(page, `${panel} .dir-list`);
                    await fill(page, `${panel} input[aria-label="Working directory"]`, override);
                    await button(page, panel, `Use ${override}`);
                    await destination(page, override);
                    const second = await start(page, app, "Worker");

                    assert.equal(second.cwd, override);
                    assert.equal(second.projectId, project.id);
                    assert.equal(second.goalId, goal.id);
                    assert.equal(
                        app.projects.list(user).projects.find((item) => item.id === project.id)
                            ?.cwd,
                        cwd,
                        "thread override does not change the project's default",
                    );
                    await home(page, scope);
                    await present(peer, `${scope} .session-row[data-id="${second.id}"]`);
                    await groupClick(
                        page,
                        scope,
                        name,
                        `[aria-label=${JSON.stringify(`New Session in ${name}`)}]`,
                    );
                    await present(page, `${panel} .session-destination`);
                    // Desktop still shows the overridden Worker beside the sidebar here.
                    await destination(page, cwd);
                    assert.equal(
                        await value(
                            page,
                            `document.querySelector('${panel} .project-goal-choices [aria-pressed=true]')?.textContent.trim()`,
                        ),
                        "No goal",
                        "project + preselects only the project",
                    );
                    await closeDialog(page);

                    await groupClick(page, scope, goal.name, ".group-head", true);
                    await disclosure(page, scope, goal.name, false, true);
                    await disclosure(page, scope, name, true);
                    await groupClick(page, scope, name, ".group-head");
                    await disclosure(page, scope, name, false);
                    await present(page, `${scope} .session-row[data-id="${standaloneChat.id}"]`);
                    await groupClick(page, scope, name, ".group-head");
                    await disclosure(page, scope, name, true);
                    // Parent reopening preserves the child's fold; the peer remains unfolded.
                    await disclosure(page, scope, goal.name, false, true);
                    await disclosure(peer, scope, goal.name, true, true);
                    await groupClick(page, scope, goal.name, ".group-head", true);
                    await disclosure(page, scope, goal.name, true, true);
                    const viewer = app.config.addUser("Read-only project viewer", "viewer");
                    const scoped = app.config.addUser("Scoped project participant", "guest", [
                        String(first.id),
                    ]);
                    const participant = await browsers.open(3);

                    await participant.setViewport(VIEWPORTS[viewport]);
                    await peer.navigate(`${base}/login?token=${encodeURIComponent(viewer.token)}`);
                    await button(peer, ".plain", "Sign in as Read-only project viewer");
                    await participant.navigate(
                        `${base}/login?token=${encodeURIComponent(scoped.token)}`,
                    );

                    for (const reader of [peer, participant]) {
                        await waitGroup(reader, scope, goal.name, true);
                        await until(
                            () =>
                                value<boolean>(
                                    reader,
                                    `(${group(scope, goal.name, true)}).querySelector('.goal-status')?.textContent.trim() === 'Active'`,
                                ),
                            "readers see the active goal state",
                        );
                        assert.equal(
                            await value(
                                reader,
                                `(${group(scope, goal.name, true)}).querySelector('.goal-status').tagName`,
                            ),
                            "SPAN",
                            "reader status is noninteractive",
                        );
                        assert.equal(
                            await value(
                                reader,
                                `(${group(scope, goal.name, true)}).querySelectorAll('.project-group-actions button').length`,
                            ),
                            0,
                            "viewers and scoped participants get no goal mutation controls",
                        );
                    }

                    await groupClick(
                        page,
                        scope,
                        goal.name,
                        `[aria-label=${JSON.stringify(`${goal.name}: Active. Mark completed`)}]`,
                        true,
                    );
                    await until(
                        () =>
                            app.projects.list(user).goals.find((item) => item.id === goal.id)
                                ?.status === "completed",
                        "goal completion persisted",
                    );

                    for (const reader of [peer, participant]) {
                        await until(
                            () =>
                                value<boolean>(
                                    reader,
                                    `(${group(scope, goal.name, true)}).querySelector('.goal-status')?.textContent.trim() === 'Completed'`,
                                ),
                            "readers receive the completed goal state",
                        );
                    }

                    assert.equal(
                        await value(
                            page,
                            `(${group(scope, goal.name, true)}).querySelector('.goal-status').tagName`,
                        ),
                        "BUTTON",
                        "owner keeps the status mutation control",
                    );
                    await shot(page, `${viewport}-completed-goal`);
                    await shot(peer, `${viewport}-reader-completed-goal`);
                    await shot(participant, `${viewport}-scoped-completed-goal`);

                    await groupClick(
                        page,
                        scope,
                        goal.name,
                        '[aria-label="Archive goal and all threads"]',
                        true,
                    );
                    await until(
                        () =>
                            [first.id, second.id].every(
                                (id) => app.sessionMeta(id as ConversationId)?.archived === true,
                            ),
                        "all goal threads archived",
                    );
                    assert.equal(app.sessionMeta(standaloneChat.id)?.archived === true, false);
                    assert.equal(app.sessionMeta(standaloneWorker.id)?.archived === true, false);
                    await until(
                        () => value<boolean>(peer, `!(${group(scope, goal.name, true)})`),
                        "peer removes archived goal from Projects",
                    );
                    await tab(page, scope, "Archived");
                    await waitGroup(page, scope, goal.name, true);
                    await present(page, `${scope} .session-row[data-id="${first.id}"]`);
                    await present(page, `${scope} .session-row[data-id="${second.id}"]`);
                    await tab(peer, scope, "Archived");
                    await waitGroup(peer, scope, goal.name, true);
                    await groupClick(
                        page,
                        scope,
                        goal.name,
                        '[aria-label="Restore goal and threads"]',
                        true,
                    );
                    await until(
                        () =>
                            [first.id, second.id].every(
                                (id) => app.sessionMeta(id as ConversationId)?.archived === false,
                            ),
                        "all goal threads restored",
                    );
                    await until(
                        () => value<boolean>(peer, `!(${group(scope, goal.name, true)})`),
                        "peer removes restored goal from Archived",
                    );
                    await tab(page, scope, "Projects");
                    await tab(peer, scope, "Projects");
                    await waitGroup(peer, scope, goal.name, true);
                    await present(page, `${scope} .session-row[data-id="${first.id}"]`);
                    await present(page, `${scope} .session-row[data-id="${second.id}"]`);
                    assert.equal(
                        app.projects.list(user).goals.find((item) => item.id === goal.id)?.status,
                        "completed",
                        "archive/restore never changes completion",
                    );

                    // Individual restore reveals the goal; restoring its remaining marked row is not invertible
                    // by archiving the whole goal again. The restore notice must only dismiss when tapped.
                    await groupClick(
                        page,
                        scope,
                        goal.name,
                        '[aria-label="Archive goal and all threads"]',
                        true,
                    );
                    await until(
                        () =>
                            [first.id, second.id].every(
                                (id) => app.sessionMeta(id as ConversationId)?.archived === true,
                            ),
                        "goal archived for the partial-restore case",
                    );
                    await tab(page, scope, "Archived");
                    await click(page, `${scope} .session-row[data-id="${first.id}"] .session`);
                    await click(page, '.topbar [aria-label="Menu"]');
                    await button(page, '[role="dialog"]', "Unarchive");
                    await present(page, '[role="dialog"]', false);
                    await home(page, scope);
                    await tab(page, scope, "Archived");
                    await until(
                        () =>
                            app.sessionMeta(first.id as ConversationId)?.archived === false &&
                            app.sessionMeta(second.id as ConversationId)?.archived === true &&
                            app.projects.list(user).goals.find((item) => item.id === goal.id)
                                ?.archived === false,
                        "individual restore leaves the other bulk-archived row untouched",
                    );
                    await groupClick(
                        page,
                        scope,
                        goal.name,
                        '[aria-label="Restore goal and threads"]',
                        true,
                    );
                    await until(
                        () => app.sessionMeta(second.id as ConversationId)?.archived === false,
                        "remaining bulk-archived row restored",
                    );
                    const restoreNotice = `[...document.querySelectorAll('.notice:not(.leaving)')]
                        .reverse().find(item => item.textContent.trim().startsWith('Restored goal.'))`;

                    await until(
                        () => value<boolean>(page, `Boolean(${restoreNotice})`),
                        "restore result notice",
                    );
                    assert.equal(
                        await value(page, `(${restoreNotice}).textContent.trim()`),
                        "Restored goal.",
                        "partial bulk restore does not advertise an unsafe Undo",
                    );
                    await page.evaluate(`(${restoreNotice}).click()`);
                    assert.equal(app.sessionMeta(first.id as ConversationId)?.archived, false);
                    assert.equal(app.sessionMeta(second.id as ConversationId)?.archived, false);
                    assert.equal(
                        app.projects.list(user).goals.find((item) => item.id === goal.id)?.archived,
                        false,
                    );
                    await tab(page, scope, "Projects");

                    await click(page, `${scope} .new-button[aria-label="New session"]`);
                    await button(page, panel, "Start a one-time chat");
                    const chat = await start(page, app, "Chat");

                    assert.equal(chat.threadType, "chat");
                    assert.equal(chat.projectId, undefined);
                    assert.equal(chat.goalId, undefined);
                    assert.equal(
                        app.projects.list(user).goals.length,
                        1,
                        "one-time Chat creates no goal",
                    );
                    await home(page, scope);
                    assert.equal(await rowTag(page, scope, chat.id, "Chat"), true);
                    await present(peer, `${scope} .session-row[data-id="${chat.id}"]`);
                    assert.equal(
                        await value(page, "document.documentElement.scrollWidth <= innerWidth"),
                        true,
                        "Projects fits the viewport",
                    );
                    assert.equal(
                        model.state.callCount,
                        0,
                        "organizing and creating threads never submits model work",
                    );
                    assert.deepEqual(
                        [page, peer]
                            .flatMap((connected) => connected.logs())
                            .filter((entry) => entry.level === "error"),
                        [],
                        "no browser errors",
                    );
                } finally {
                    await browsers.closeAll({ final: true });
                    server.closeAllConnections();
                    await new Promise<void>((resolve) => server.close(() => resolve()));
                    await app.close();
                }
            });
        }
    },
);
