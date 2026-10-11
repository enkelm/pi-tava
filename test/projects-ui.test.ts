// Authoring gate: real UI choices must preserve project/goal membership and reach durable state.
// Regressions: orphan goals, lost creation/rename controls, labelled sidebar chips and stale peers.
// App tests own storage/access/migration; this owns browser disclosure, forms and event delivery.
// Sidebar regressions: goal indentation, busy-loader drift, active idle accent and lost result-read marks.
// Real run completion and browser storage/visibility events own the result lifecycle; app tests do not render it.
// Menu contracts share this fixture: misplaced/right-click navigation, focus loss, omitted actions,
// coarse-pointer hover-only traps and status text/icon regressions are not reached by app tests.
// Header geometry owns invisible shortcuts reserving width and capped labels stranding the count.
// Session-moves UI owns thread menus; this covers project/goal menus through DOM and trusted input.
// Uses public app/model/browser APIs; no test-only production seams or state flags.
import {
    type App,
    cleanUp,
    context,
    lastText,
    newSession,
    openApp,
    owner,
    root,
    say,
    scriptedModel,
    until,
    work,
} from "./helpers.ts";
import assert from "node:assert/strict";
import { mkdirSync, realpathSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import { join } from "node:path";
import { after, test } from "node:test";
import { fauxAssistantMessage } from "@earendil-works/pi-ai/providers/faux";
import type { ConversationId } from "@earendil-works/pi-durable";
import { Browsers } from "../src/server/browser.ts";
import { findBrowser } from "../src/server/browser/discovery.ts";
import { Chromium } from "../src/server/browser/cdp.ts";
import { BrowserPage } from "../src/server/browser/page.ts";
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

function groupHead(scope: string, name: string) {
    return `${scope} .project-group-head > .group-head[title=${JSON.stringify(name)}]`;
}

function optionsSurface(name: string, mobile: boolean) {
    return `[role="${mobile ? "dialog" : "menu"}"][aria-label=${JSON.stringify(name)}]`;
}

async function options(
    page: BrowserPage,
    scope: string,
    name: string,
    mobile: boolean,
    goal = false,
) {
    await waitGroup(page, scope, name, goal);
    const before = await value<string>(page, "location.pathname");
    const expanded = await value<string>(
        page,
        `document.querySelector(${JSON.stringify(groupHead(scope, name))}).getAttribute('aria-expanded')`,
    );
    const surface = optionsSurface(name, mobile);

    if (mobile) {
        // These are separate intentional gestures, not a double tap on a just-swapped sheet.
        await page.evaluate(`await new Promise(resolve => setTimeout(resolve, 300))`);
        await page.click({
            selector: `${scope} [aria-label=${JSON.stringify(`Options for ${name}`)}]`,
        });
    } else {
        const point = await value<{ x: number; y: number }>(
            page,
            `(() => {
                const head = document.querySelector(${JSON.stringify(groupHead(scope, name))});

                head.scrollIntoView({ block: 'nearest' });
                const rect = head.getBoundingClientRect();

                return { x: rect.left + 24, y: rect.top + 12 };
            })()`,
        );

        await page.input([{ type: "click", button: "right", ...point }]);
        await present(page, surface);
        await until(
            () =>
                value<boolean>(
                    page,
                    `(() => {
                        const menu = document.querySelector(${JSON.stringify(surface)}).getBoundingClientRect();

                        return Math.abs(menu.left - ${point.x}) < 2
                            && Math.abs(menu.top - ${point.y}) < 2;
                    })()`,
                ),
            "desktop options open at the clicked point, not centered or at the active conversation",
        );
    }

    await present(page, surface);
    assert.equal(await value(page, "location.pathname"), before, "options never open the thread");
    assert.equal(
        await value(
            page,
            `document.querySelector(${JSON.stringify(groupHead(scope, name))}).getAttribute('aria-expanded')`,
        ),
        expanded,
        "opening options does not toggle disclosure",
    );

    return surface;
}

async function optionLabels(page: BrowserPage, surface: string, expected: string[]) {
    assert.deepEqual(
        await value(
            page,
            `[...document.querySelectorAll(${JSON.stringify(`${surface} button:not([aria-label="Close"])`)})]
                .map(button => button.textContent.trim())`,
        ),
        expected,
        "named options include the existing shortcuts as well as menu-only actions",
    );
}

async function keyboardOptions(page: BrowserPage, scope: string, name: string, contextKey = false) {
    const head = groupHead(scope, name);
    const surface = optionsSurface(name, false);

    await page.evaluate(`document.querySelector(${JSON.stringify(head)}).focus()`);

    if (contextKey) {
        // BrowserPage's key table lacks ContextMenu; dispatch its DOM key without a production seam.
        await page.evaluate(`document.activeElement.dispatchEvent(new KeyboardEvent('keydown', {
            key: 'ContextMenu', bubbles: true, cancelable: true,
        }))`);
    } else {
        await page.press("Shift+F10");
    }

    await present(page, surface);
    const focused = (index: string) =>
        `document.activeElement === [...document.querySelectorAll(${JSON.stringify(`${surface} [role="menuitem"]`)})].at(${index})`;

    await until(() => value<boolean>(page, focused("0")), "menu focuses its first action");
    await page.press("ArrowDown");
    assert.equal(await value(page, focused("1")), true, "ArrowDown reaches the next action");
    await page.press("ArrowUp");
    assert.equal(await value(page, focused("0")), true, "ArrowUp reaches the previous action");
    await page.press("End");
    assert.equal(await value(page, focused("-1")), true, "End reaches the last action");
    await page.press("Home");
    assert.equal(await value(page, focused("0")), true, "Home reaches the first action");
    await page.press("Escape");
    await present(page, surface, false);
    await until(
        () =>
            value<boolean>(
                page,
                `document.activeElement === document.querySelector(${JSON.stringify(head)})`,
            ),
        "Escape returns focus to the originating header",
    );
}

async function heldOptions(page: BrowserPage, scope: string, name: string, ghostOnMenu = false) {
    const head = groupHead(scope, name);
    const expanded = await value<string>(
        page,
        `document.querySelector(${JSON.stringify(head)}).getAttribute('aria-expanded')`,
    );
    const before = await value<string>(page, "location.pathname");
    const surface = optionsSurface(name, true);

    await page.evaluate(`
        const target = document.querySelector(${JSON.stringify(head)});
        const rect = target.getBoundingClientRect();
        const finger = new Touch({
            identifier: 1, target, clientX: rect.left + 24, clientY: rect.top + 12,
        });

        target.dispatchEvent(new TouchEvent('touchstart', {
            bubbles: true, cancelable: true, touches: [finger], changedTouches: [finger],
        }));
    `);
    await present(page, surface);
    const consumed = await value<boolean>(
        page,
        `(() => {
        const target = document.querySelector(${JSON.stringify(head)});
        const rect = target.getBoundingClientRect();
        const finger = new Touch({
            identifier: 1, target, clientX: rect.left + 24, clientY: rect.top + 12,
        });
        const lift = new TouchEvent('touchend', {
            bubbles: true, cancelable: true, touches: [], changedTouches: [finger],
        });

        target.dispatchEvent(lift);
        const recipient = ${
            ghostOnMenu
                ? `document.querySelector(${JSON.stringify(surface)}).querySelector('button:not([aria-label="Close"])')`
                : "target"
        };
        const ghost = new MouseEvent('click', { bubbles: true, cancelable: true, detail: 1 });

        recipient.dispatchEvent(ghost);

        return lift.defaultPrevented && ghost.defaultPrevented;
    })()`,
    );

    assert.equal(consumed, true, "a committed hold consumes lift and its compatibility click");
    await present(page, surface);
    await until(
        () =>
            value<boolean>(
                page,
                `Math.abs(document.querySelector(${JSON.stringify(surface)}).getBoundingClientRect().bottom - innerHeight) < 2`,
            ),
        "coarse-pointer holds anchor a dialog to the bottom edge, not a centered popup",
    );
    assert.equal(await value(page, "location.pathname"), before);
    assert.equal(
        await value(
            page,
            `document.querySelector(${JSON.stringify(head)}).getAttribute('aria-expanded')`,
        ),
        expanded,
        "the compatibility click after a hold cannot collapse the header",
    );
    await page.press("Escape");
    await present(page, surface, false);
}

async function groupControls(
    page: BrowserPage,
    scope: string,
    name: string,
    mobile: boolean,
    goal = false,
) {
    const labels = goal
        ? [`New Session in ${name}`, "Archive goal and all threads"]
        : [`New Session in ${name}`, `Edit ${name}`];
    const visibility = (shown: boolean) =>
        `(() => {
            const section = ${group(scope, name, goal)};
            const visible = element => {
                if (!element || !element.getBoundingClientRect().width) {
                    return false;
                }

                for (let each = element; each; each = each.parentElement) {
                    const style = getComputedStyle(each);

                    if (style.display === 'none' || style.visibility === 'hidden' || Number(style.opacity) === 0) {
                        return false;
                    }
                }

                return true;
            };

            return ${JSON.stringify(labels)}.every(label => {
                const control = section.querySelector(
                    ':scope > .project-group-head [aria-label="' + label + '"]',
                );

                return visible(control) === ${shown}
                    && Math.abs(control.getBoundingClientRect().width - ${shown ? 40 : 0}) < 1;
            }) && ${goal ? "visible(section.querySelector('.goal-state'))" : "true"};
        })()`;

    await page.input([{ type: "mouse", action: "move", x: 1270, y: 790 }]);
    await page.evaluate(`document.querySelector('${scope} .new-button').focus()`);
    await until(
        () => value<boolean>(page, visibility(false)),
        "idle headers hide shortcuts without reserving horizontal space",
    );

    if (!mobile) {
        assert.equal(
            await value(
                page,
                `(() => {
                    const header = (${group(scope, name, goal)}).querySelector(':scope > .project-group-head');
                    const edge = header.getBoundingClientRect().right;
                    const button = header.querySelector('.group-head');
                    const head = button.getBoundingClientRect();
                    const padding = parseFloat(getComputedStyle(button).paddingRight);
                    const count = header.querySelector('.group-count').getBoundingClientRect();

                    return Math.abs(head.right - edge) < 4
                        && count.width > 0 && Math.abs(head.right - count.right - padding) < 1;
                })()`,
            ),
            true,
            "idle project and goal labels/counts use the full header width",
        );
    }

    // A real Tab establishes keyboard modality before programmatic focus chooses this header.
    // Coarse-pointer devices must retain keyboard access, not just their explicit touch Options.
    await page.press("Tab");
    await page.evaluate(
        `document.querySelector(${JSON.stringify(groupHead(scope, name))}).focus()`,
    );
    await until(
        () => value<boolean>(page, visibility(true)),
        "keyboard focus reveals full-width header shortcuts, including on coarse pointers",
    );
    await page.evaluate(`document.querySelector('${scope} .new-button').focus()`);
    await page.hover({ selector: groupHead(scope, name) });
    await until(
        () => value<boolean>(page, visibility(!mobile)),
        mobile
            ? "coarse pointers never reveal hover-only shortcuts"
            : "desktop hover reveals header shortcuts",
    );
    assert.equal(
        await value(
            page,
            `(${group(scope, name, goal)}).querySelectorAll(':scope > .project-group-head [aria-label^="Rename goal "]').length`,
        ),
        0,
        "goal rename lives in options, not a hover control",
    );
}

async function goalStatus(
    page: BrowserPage,
    scope: string,
    name: string,
    state: "Active" | "Completed",
    interactive = true,
) {
    await until(
        () =>
            value<boolean>(
                page,
                `(() => {
                    const header = (${group(scope, name, true)}).querySelector(':scope > .project-group-head');
                    const head = header.querySelector('.group-head');
                    const status = header.querySelector(':scope > .goal-state');
                    const icon = status?.querySelector('svg')?.getBoundingClientRect();
                    const label = head.querySelector('.group-name').getBoundingClientRect();
                    const swatch = document.createElement('span');

                    swatch.style.color = 'var(${state === "Completed" ? "--o-green" : "--muted"})';
                    head.append(swatch);
                    const color = status && getComputedStyle(status).color === getComputedStyle(swatch).color;

                    swatch.remove();

                    return status?.getAttribute('aria-label')?.includes(${JSON.stringify(state)})
                        && status.title.includes(${JSON.stringify(state)})
                        && ${interactive ? "status.tagName === 'BUTTON'" : "status.tagName !== 'BUTTON' && status.getAttribute('role') === 'img' && status.tabIndex === -1"}
                        && status.textContent.trim() === '' && icon?.width > 0 && icon?.height > 0
                        && Boolean(status.querySelector('svg path')?.getAttribute('d'))
                        && status.getBoundingClientRect().right <= head.getBoundingClientRect().left
                        && icon.right <= label.left && color;
                })()`,
            ),
        `the leading sibling goal ${interactive ? "control" : "indicator"} exposes ${state} accessibly`,
    );

    return value<string>(
        page,
        `(${group(scope, name, true)}).querySelector(':scope > .project-group-head .goal-state svg path').getAttribute('d')`,
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
    await idleState(page, scope, id, false);
    assert.equal(
        result.color,
        true,
        `${type} uses its ${type === "Chat" ? "green" : "blue"} theme color`,
    );

    return result.ordinary;
}

async function idleState(page: BrowserPage, scope: string, id: number, unread: boolean) {
    const selector = `${scope} .session-row[data-id="${id}"] .session-side .state-idle`;

    await present(page, selector);
    await until(
        () =>
            value<boolean>(
                page,
                `(() => {
                    const marker = document.querySelector(${JSON.stringify(selector)});
                    const style = getComputedStyle(marker);
                    const swatch = document.createElement('span');

                    swatch.style.color = 'var(${unread ? "--accent" : "--faint"})';
                    marker.parentElement.append(swatch);
                    const color = getComputedStyle(swatch).color;

                    swatch.remove();

                    // Chromium suspends CSS transitions in background tabs; their read classes
                    // still update. Color assertions belong to the foreground tab's rendered state.
                    return marker.classList.contains('unread') === ${unread}
                        && marker.classList.contains('pulse') === ${unread}
                        && (document.visibilityState === 'hidden' || (
                            style.borderTopColor === color
                            && style.backgroundColor === ${unread ? "color" : "'rgba(0, 0, 0, 0)'"}
                        ));
                })()`,
            ),
        `${id}: ${unread ? "unread accent square" : "neutral read square, even when active"}`,
    );
    assert.equal(
        await value(
            page,
            `document.querySelector(${JSON.stringify(selector)}).getAttribute('aria-label')`,
        ),
        unread ? "Unread messages" : null,
        "the unread state is accessible without relying on color or motion",
    );
}

async function alignedRows(page: BrowserPage, scope: string, goalId: number, otherId: number) {
    await until(
        () =>
            value<boolean>(
                page,
                `(() => {
                    const goal = document.querySelector('${scope} .session-row[data-id="${goalId}"] .session').getBoundingClientRect();
                    const other = document.querySelector('${scope} .session-row[data-id="${otherId}"] .session').getBoundingClientRect();
                    const bar = document.querySelector('${scope} .session-items > .slide-y')?.getBoundingClientRect();

                    return Math.abs(goal.left - other.left) < 1
                        && Math.abs(goal.right - other.right) < 1
                        && (!bar || Math.abs(goal.left - bar.left) < 1);
                })()`,
            ),
        "goal thread borders align with other rows and the active bar",
    );
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
                    const projectOptions = await options(
                        page,
                        scope,
                        initialName,
                        viewport === "mobile",
                    );

                    await optionLabels(page, projectOptions, [
                        "New Session here…",
                        "New goal…",
                        "Edit project…",
                    ]);
                    await button(page, projectOptions, "Edit project…");
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

                    await groupControls(page, scope, name, viewport === "mobile");

                    if (viewport === "desktop") {
                        await click(
                            page,
                            `${scope} .session-row[data-id="${standaloneChat.id}"] .session`,
                        );
                        await keyboardOptions(page, scope, name);
                    } else {
                        await heldOptions(page, scope, name);
                    }

                    const newGoalOptions = await options(page, scope, name, viewport === "mobile");

                    await button(page, newGoalOptions, "New goal…");
                    await present(page, `${panel} .session-destination`);
                    await destination(page, cwd);
                    assert.equal(
                        await value(
                            page,
                            `document.querySelector('${panel} .project-goal-choices [aria-pressed=true]')?.textContent.trim()`,
                        ),
                        "New Goal",
                        "the named project's New goal shortcut preselects creation intent",
                    );
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

                    if (viewport === "mobile") {
                        // The compact drawer retains an active row while the home list does not.
                        await page.press(
                            (await value<boolean>(page, "(await import('/ui.js')).APPLE"))
                                ? "Meta+B"
                                : "Control+B",
                        );
                        const drawer = ".drawer .sessions";

                        await present(page, `${drawer} .session-row.active[data-id="${first.id}"]`);
                        await idleState(page, drawer, first.id, false);
                        await alignedRows(page, drawer, first.id, standaloneWorker.id);
                        await click(page, ".drawer-overlay");
                        await present(page, ".drawer", false);
                    }

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
                    assert.equal(await rowTag(page, scope, first.id, "Worker"), false);
                    await alignedRows(page, scope, first.id, standaloneWorker.id);
                    assert.equal(
                        await rowTag(page, scope, standaloneChat.id, "Chat"),
                        true,
                        "sharing a cwd never assigns a standalone Chat to the project",
                    );

                    await groupControls(page, scope, goal.name, viewport === "mobile", true);
                    const activeIcon = await goalStatus(page, scope, goal.name, "Active");

                    if (viewport === "desktop") {
                        // Mutate a named sidebar object while another, unassigned conversation stays open.
                        await click(
                            page,
                            `${scope} .session-row[data-id="${standaloneChat.id}"] .session`,
                        );
                        await keyboardOptions(page, scope, goal.name, true);
                    } else {
                        // The ghost click now lands on the newly shown sheet, not its original header.
                        await heldOptions(page, scope, goal.name, true);
                        // Landscape crosses the ordinary centered-Sheet breakpoint without gaining hover.
                        await page.setViewport({ ...VIEWPORTS.mobile, width: 820, height: 600 });
                        await groupControls(page, scope, goal.name, true, true);
                        await heldOptions(page, scope, goal.name, true);
                        await page.setViewport(VIEWPORTS.mobile);
                    }

                    let goalOptions = await options(
                        page,
                        scope,
                        goal.name,
                        viewport === "mobile",
                        true,
                    );

                    await optionLabels(page, goalOptions, [
                        "New Session here…",
                        "Rename goal…",
                        "Mark completed",
                        "Archive goal and all threads",
                    ]);
                    await button(page, goalOptions, "Rename goal…");
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

                    goalOptions = await options(
                        page,
                        scope,
                        goal.name,
                        viewport === "mobile",
                        true,
                    );
                    await button(page, goalOptions, "Rename goal…");
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

                    if (viewport === "desktop") {
                        // The hover shortcut stays usable; touch reaches the same action in Options.
                        await page.hover({ selector: groupHead(scope, goal.name) });
                        await page.evaluate(
                            `await new Promise(resolve => setTimeout(resolve, 300))`,
                        );
                        await page.click({
                            selector: `${scope} [aria-label=${JSON.stringify(`New Session in ${goal.name}`)}]`,
                        });
                    } else {
                        goalOptions = await options(page, scope, goal.name, true, true);
                        await button(page, goalOptions, "New Session here…");
                    }

                    await present(page, `${panel} .session-destination`);
                    await destination(page, cwd);
                    assert.equal(
                        await value(
                            page,
                            `document.querySelector('${panel} .project-goal-choices [aria-pressed=true]')?.textContent.trim()`,
                        ),
                        goal.name,
                        "the goal shortcut preselects its project and goal",
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
                    const newSessionOptions = await options(
                        page,
                        scope,
                        name,
                        viewport === "mobile",
                    );

                    await button(page, newSessionOptions, "New Session here…");
                    await present(page, `${panel} .session-destination`);
                    // Desktop still shows the overridden Worker beside the sidebar here.
                    await destination(page, cwd);
                    assert.equal(
                        await value(
                            page,
                            `document.querySelector('${panel} .project-goal-choices [aria-pressed=true]')?.textContent.trim()`,
                        ),
                        "No goal",
                        "project options preselect only the named project, not the open thread's goal",
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
                        await goalStatus(reader, scope, goal.name, "Active", false);
                        assert.equal(
                            await value(
                                reader,
                                `(${group(scope, goal.name, true)}).querySelectorAll('.project-group-actions button').length`,
                            ),
                            0,
                            "viewers and scoped participants get no goal mutation controls",
                        );
                    }

                    const statusControl = `${scope} .goal-section > .project-group-head .goal-state`;
                    const goalHead = groupHead(scope, goal.name);
                    const expanded = await value<string>(
                        page,
                        `document.querySelector(${JSON.stringify(goalHead)}).getAttribute('aria-expanded')`,
                    );

                    await page.click({ selector: statusControl });
                    assert.equal(
                        await value(
                            page,
                            `document.querySelector(${JSON.stringify(goalHead)}).getAttribute('aria-expanded')`,
                        ),
                        expanded,
                        "clicking the leading status control does not fold the goal",
                    );
                    await until(
                        () =>
                            app.projects.list(user).goals.find((item) => item.id === goal.id)
                                ?.status === "completed",
                        "goal completion persisted",
                    );

                    for (const reader of [peer, participant]) {
                        await goalStatus(reader, scope, goal.name, "Completed", false);
                    }

                    await shot(page, `${viewport}-completed-goal`);
                    await shot(peer, `${viewport}-reader-completed-goal`);
                    await shot(participant, `${viewport}-scoped-completed-goal`);

                    const completedIcon = await goalStatus(page, scope, goal.name, "Completed");

                    assert.notEqual(
                        completedIcon,
                        activeIcon,
                        "completion changes the leading glyph",
                    );

                    // The same status control must not reopen a collapsed goal.
                    await groupClick(page, scope, goal.name, ".group-head", true);
                    await disclosure(page, scope, goal.name, false, true);
                    await page.click({ selector: statusControl });
                    await disclosure(page, scope, goal.name, false, true);
                    await goalStatus(page, scope, goal.name, "Active");
                    await page.click({ selector: statusControl });
                    await disclosure(page, scope, goal.name, false, true);
                    await goalStatus(page, scope, goal.name, "Completed");
                    await groupClick(page, scope, goal.name, ".group-head", true);
                    await disclosure(page, scope, goal.name, true, true);

                    // Options remains bound to this named goal and updates its leading state icon.
                    for (const status of ["active", "completed"] as const) {
                        goalOptions = await options(
                            page,
                            scope,
                            goal.name,
                            viewport === "mobile",
                            true,
                        );
                        await button(
                            page,
                            goalOptions,
                            status === "active" ? "Mark active" : "Mark completed",
                        );
                        await until(
                            () =>
                                app.projects.list(user).goals.find((item) => item.id === goal.id)
                                    ?.status === status,
                            `named goal options persist ${status}`,
                        );
                        await present(page, goalOptions, false);
                        // Durable writes precede the coalesced catalogue event; reopen only after it arrives.
                        assert.equal(
                            await goalStatus(
                                page,
                                scope,
                                goal.name,
                                status === "active" ? "Active" : "Completed",
                            ),
                            status === "active" ? activeIcon : completedIcon,
                            "status transitions restore the matching leading glyph",
                        );
                    }

                    goalOptions = await options(
                        page,
                        scope,
                        goal.name,
                        viewport === "mobile",
                        true,
                    );
                    await optionLabels(page, goalOptions, [
                        "New Session here…",
                        "Rename goal…",
                        "Mark active",
                        "Archive goal and all threads",
                    ]);
                    await button(page, goalOptions, "Archive goal and all threads");
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
                    goalOptions = await options(
                        page,
                        scope,
                        goal.name,
                        viewport === "mobile",
                        true,
                    );
                    await optionLabels(page, goalOptions, [
                        "Rename goal…",
                        "Mark active",
                        "Restore goal and threads",
                    ]);
                    await button(page, goalOptions, "Restore goal and threads");
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
                    goalOptions = await options(
                        page,
                        scope,
                        goal.name,
                        viewport === "mobile",
                        true,
                    );
                    await button(page, goalOptions, "Archive goal and all threads");
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
                    goalOptions = await options(
                        page,
                        scope,
                        goal.name,
                        viewport === "mobile",
                        true,
                    );
                    await button(page, goalOptions, "Restore goal and threads");
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
                } catch (error) {
                    // Preserve real DOM placement/action evidence before the fixture closes its pages.
                    try {
                        const page = await browsers.open(1);
                        const snapshot = await value(
                            page,
                            `await (async () => {
                            const { store } = await import('/store.js');
                            const sheet = store.state.sheet;

                            return {
                                path: location.pathname,
                                sheet: sheet && {
                                    type: sheet.type, kind: sheet.kind, id: sheet.id,
                                    at: sheet.at, archivedView: sheet.archivedView,
                                },
                                surfaces: [...document.querySelectorAll('[role="menu"], [role="dialog"]')]
                                    .map(element => ({
                                        role: element.getAttribute('role'),
                                        name: element.getAttribute('aria-label'),
                                        rect: element.getBoundingClientRect().toJSON(),
                                        css: element.style.cssText,
                                        actions: [...element.querySelectorAll('button')]
                                            .map(button => button.textContent.trim()),
                                    })),
                                statuses: [...document.querySelectorAll('.goal-state')]
                                    .map(element => ({
                                        label: element.getAttribute('aria-label'), title: element.title,
                                        rect: element.getBoundingClientRect().toJSON(),
                                    })),
                            };
                        })()`,
                        );

                        console.error(
                            "Sidebar Options failure snapshot:",
                            JSON.stringify(snapshot),
                        );
                    } catch (diagnosticError) {
                        console.error("Could not capture Options failure:", diagnosticError);
                    }

                    throw error;
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

test(
    "Sidebar status: completed results are unread until seen, across reloads, tabs and visibility",
    { skip: findBrowser() === undefined ? "no Chromium installed" : false, timeout: 90_000 },
    async () => {
        let gate: { entered: boolean; wait: Promise<void>; release: () => void } | undefined;
        const model = scriptedModel(async (request) => {
            const text = lastText(request as never).text;

            if (text.includes("held") && gate !== undefined) {
                gate.entered = true;
                await gate.wait;
            }

            return fauxAssistantMessage(`result: ${text}`);
        });
        const app = await openApp(model, join(root, "sidebar-status-data"));
        const id = await newSession(app);
        const old = await newSession(app);

        await say(app, old, "old result");
        const server = createServer(
            createHandler({ app, listen: { host: "127.0.0.1", port: 0 }, restart: () => {} }),
        );

        await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
        const base = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
        // Two genuine tabs in one temporary profile: localStorage events are delivered by Chromium,
        // not manually dispatched as in the existing peeks merge-conflict test.
        const chromium = await Chromium.launch(
            findBrowser()!,
            join(root, "sidebar-status-browser"),
            [],
        );
        const pages: BrowserPage[] = [];
        const desktop = ".sidebar .sessions";
        const mobile = ".home-list .sessions";

        const openTab = async () => {
            const { targetId } = await chromium.connection.send("Target.createTarget", {
                url: "about:blank",
            });
            const { sessionId } = await chromium.connection.send("Target.attachToTarget", {
                targetId,
                flatten: true,
            });
            const page = new BrowserPage({
                conversationId: pages.length + 1,
                connection: chromium.connection,
                session: sessionId,
                target: targetId,
                context: undefined,
                userAgent: chromium.userAgent,
                viewport: VIEWPORTS.desktop,
                changed: () => {},
                saved: () => {},
            });

            pages.push(page);
            await page.init();
            await chromium.connection.send(
                "Emulation.setEmulatedMedia",
                { features: [{ name: "prefers-reduced-motion", value: "no-preference" }] },
                sessionId,
            );

            return page;
        };

        const startHeld = async () => {
            let release = () => {};

            const wait = new Promise<void>((resolve) => {
                release = resolve;
            });

            gate = { entered: false, wait, release };
            const { submissionId } = await app.commands.submit(id, owner(app), {
                text: "held result",
                requestId: crypto.randomUUID(),
            });

            await until(() => gate?.entered === true && app.isBusy(id), "the model held mid-run");

            return async () => {
                release();
                await (await app.harness.submission(submissionId, context))!.wait(context);
                await until(() => !app.isBusy(id), "the completed run");
            };
        };

        const spinner = async (page: BrowserPage, scope: string) => {
            const row = `${scope} .session-row[data-id="${id}"]`;

            await present(page, `${row} .session-side .spinner[role="img"][aria-label="Working"]`);
            assert.equal(
                await value(
                    page,
                    `document.querySelector('${row} .mini-sweep, ${row} .state-idle') === null`,
                ),
                true,
                "busy uses the shared quadrant loader, never the mini-sweep or idle square",
            );
        };

        const infinitePulse = (page: BrowserPage, selector: string) =>
            value<boolean>(
                page,
                `getComputedStyle(document.querySelector(${JSON.stringify(selector)})).animationIterationCount.split(', ').includes('infinite')`,
            );

        try {
            const page = await openTab();

            await page.navigate(`${base}/login?token=${encodeURIComponent(app.config.ownerToken)}`);
            await idleState(page, desktop, id, false);
            await idleState(page, desktop, old, false);
            const since = await value<number>(
                page,
                "Number(localStorage.getItem('pocket.peekSince'))",
            );
            const peer = await openTab();

            assert.ok(since > 0, "the existing first-look key is retained");
            await peer.navigate(base);
            await idleState(peer, desktop, id, false);
            let finish = await startHeld();

            await chromium.connection.send("Target.activateTarget", { targetId: page.targetId });
            await spinner(page, desktop);
            await page.setViewport(VIEWPORTS.mobile);
            await spinner(page, mobile);
            await finish();
            await idleState(page, mobile, id, true);
            await idleState(peer, desktop, id, true);
            assert.equal(
                await infinitePulse(page, `${mobile} .session-row[data-id="${id}"] .state-idle`),
                true,
            );
            await button(page, `${mobile} .sessions-foot`, "Settings");
            await button(page, "#settings-panel-appearance", "Reduced");
            await click(page, '[role="dialog"][aria-label="Settings"] [aria-label="Close"]');
            await present(page, '[role="dialog"]', false);
            assert.equal(await value(page, "document.documentElement.dataset.motion"), "reduced");
            await idleState(page, mobile, id, true);
            assert.equal(
                await infinitePulse(page, `${mobile} .session-row[data-id="${id}"] .state-idle`),
                false,
                "reduced motion retains the unread accent without an infinite pulse",
            );
            await page.setViewport(VIEWPORTS.desktop);
            await page.reload();
            await idleState(page, desktop, id, true);
            assert.equal(
                await value(page, "Number(localStorage.getItem('pocket.peekSince'))"),
                since,
            );
            assert.equal(
                await value(page, "document.querySelector('.peeks, .peek-strip') === null"),
                true,
                "sidebar read tracking works without enabling peek tiles",
            );
            await chromium.connection.send("Target.activateTarget", { targetId: peer.targetId });
            await click(peer, `${desktop} .session-row[data-id="${id}"] .session`);
            await present(peer, `${desktop} .session-row.active[data-id="${id}"]`);
            await idleState(peer, desktop, id, false);
            await idleState(page, desktop, id, false);
            assert.ok(
                (await value<number>(
                    page,
                    `Number(localStorage.getItem('pocket.peekSeen.${id}'))`,
                )) >= app.sessions().find((session) => session.id === id)!.endedAt!,
                "opening in the other tab persists the existing per-session seen key",
            );
            await page.reload();
            await idleState(page, desktop, id, false);

            finish = await startHeld();
            await spinner(peer, desktop);
            assert.equal(await value(peer, "document.visibilityState"), "visible");
            await finish();
            await idleState(peer, desktop, id, false);
            await idleState(page, desktop, id, false);
            await click(peer, `${desktop} .session-row[data-id="${old}"] .session`);
            await idleState(peer, desktop, id, false);
            await peer.reload();
            await idleState(peer, desktop, id, false);

            // An open but hidden conversation has not been seen; restoring visibility reads its result.
            await click(peer, `${desktop} .session-row[data-id="${id}"] .session`);
            finish = await startHeld();
            await spinner(peer, desktop);
            await peer.evaluate(`
                Object.defineProperty(document, 'visibilityState', { value: 'hidden', configurable: true });
                document.dispatchEvent(new Event('visibilitychange'));
            `);
            await finish();
            await idleState(peer, desktop, id, true);
            await idleState(page, desktop, id, true);
            await peer.evaluate(`
                delete document.visibilityState;
                document.dispatchEvent(new Event('visibilitychange'));
            `);
            await idleState(peer, desktop, id, false);
            await idleState(page, desktop, id, false);

            const { user: chatter } = app.config.addUser("Sidebar chatter", "guest");

            await app.collab.postChat(id, chatter, {
                text: "People chat still counts as unread",
                requestId: crypto.randomUUID(),
            });
            await idleState(peer, desktop, id, true);
            await idleState(page, desktop, id, true);
            await click(peer, ".topbar .people-button");
            await present(peer, ".chat-msg");
            await idleState(peer, desktop, id, false);
            assert.deepEqual(
                pages
                    .flatMap((connected) => connected.logs())
                    .filter((entry) => entry.level === "error"),
                [],
                "no browser errors or module-cycle failures",
            );
        } finally {
            gate?.release();

            for (const page of pages) {
                page.close();
            }

            await chromium.stop();
            server.closeAllConnections();
            await new Promise<void>((resolve) => server.close(() => resolve()));
            await app.close();
        }
    },
);
