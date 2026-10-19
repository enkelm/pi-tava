// Authoring gate: real UI choices must preserve project membership and reach durable state.
// Regressions: lost project controls, extra grouping levels, labelled sidebar chips and stale peers.
// App tests own storage/access; this owns browser disclosure, forms and event delivery.
// Sidebar regressions: row indentation, busy-loader drift, active idle accent and lost result-read marks.
// Real run completion and browser storage/visibility events own the result lifecycle; app tests do not render it.
// Menu contracts share this fixture: misplaced/right-click navigation, focus loss, omitted actions,
// coarse-pointer hover-only traps and thread type icons are not reached by app tests.
// Header geometry owns invisible shortcuts reserving width and capped labels stranding the count.
// Session-moves UI owns thread menus; this covers project menus through DOM and trusted input.
// Pull/Researcher starters own rendered selection and type indicators; backend tests do not render them.
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
import { execFileSync } from "node:child_process";
import { mkdirSync, realpathSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import { join } from "node:path";
import { after, test } from "node:test";
import { fauxAssistantMessage, fauxToolCall } from "@earendil-works/pi-ai/providers/faux";
import type { ConversationId } from "@earendil-works/pi-durable";
import { Browsers } from "../src/server/browser.ts";
import { findBrowser } from "../src/server/browser/discovery.ts";
import { Chromium } from "../src/server/browser/cdp.ts";
import { BrowserPage } from "../src/server/browser/page.ts";
import { VIEWPORTS } from "../src/server/browser/viewport.ts";
import { createHandler } from "../src/server/http.ts";

const sessionDialog = '[role="dialog"][aria-label="New Session"]';
const panel = `${sessionDialog} #session-panel-new`;
const projectNameField = 'input[aria-label="Project name"]';
const projectPathField = 'input[aria-label="Default working directory"]';

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

function group(scope: string, name: string) {
    const selector = `${scope} .project-section`;

    return `[...document.querySelectorAll(${JSON.stringify(selector)})].find(section =>
        section.querySelector(':scope > .project-group-head .group-name')?.textContent.trim()
            === ${JSON.stringify(name)})`;
}

async function waitGroup(page: BrowserPage, scope: string, name: string) {
    await until(() => value<boolean>(page, `Boolean(${group(scope, name)})`), `project ${name}`);
}

async function groupClick(page: BrowserPage, scope: string, name: string, selector: string) {
    await waitGroup(page, scope, name);
    await page.evaluate(
        `(${group(scope, name)}).querySelector(${JSON.stringify(selector)}).click()`,
    );
}

function groupHead(scope: string, name: string) {
    return `${scope} .project-group-head > .group-head[title=${JSON.stringify(name)}]`;
}

function optionsSurface(name: string, mobile: boolean) {
    return `[role="${mobile ? "dialog" : "menu"}"][aria-label=${JSON.stringify(name)}]`;
}

async function options(page: BrowserPage, scope: string, name: string, mobile: boolean) {
    await waitGroup(page, scope, name);
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

async function groupControls(page: BrowserPage, scope: string, name: string, mobile: boolean) {
    const labels = [`New Session in ${name}`, `Edit ${name}`];
    const visibility = (shown: boolean) =>
        `(() => {
            const section = ${group(scope, name)};
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
            });
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
                    const header = (${group(scope, name)}).querySelector(':scope > .project-group-head');
                    const edge = header.getBoundingClientRect().right;
                    const button = header.querySelector('.group-head');
                    const head = button.getBoundingClientRect();
                    const padding = parseFloat(getComputedStyle(button).paddingRight);
                    const count = header.querySelector('.group-count').getBoundingClientRect();
                    const label = header.querySelector('.group-name').getBoundingClientRect();

                    return Math.abs(head.right - edge) < 4
                        && count.width > 0
                        && count.right <= label.left
                        && Math.abs(head.right - label.right - padding) < 1;
                })()`,
            ),
            true,
            "idle project labels/counts use the full header width, with counts before titles",
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
}

async function disclosure(page: BrowserPage, scope: string, name: string, expanded: boolean) {
    await until(
        () =>
            value<boolean>(
                page,
                `(() => {
                    const section = ${group(scope, name)};
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
    await present(page, `${panel} .session-destination`);
    assert.equal(
        await value(
            page,
            `document.querySelector('${panel} .project-choice-row[aria-pressed=true]')?.textContent.trim()`,
        ),
        name,
        "selecting a project goes directly to thread and working-directory controls",
    );
}

async function destination(page: BrowserPage, cwd: string) {
    assert.equal(
        await value(
            page,
            `document.querySelector('${panel} select[aria-label="Working location"]')`,
        ),
        null,
        "starting from a project does not mount destination or SSH controls until Change",
    );
    assert.equal(
        await value(page, `document.querySelector('${panel} .session-path .mono').title`),
        cwd,
        "new sessions display the project's default cwd, not the open thread's cwd",
    );
}

async function start(page: BrowserPage, app: App, type: "Worker" | "Chat" | "Pull" | "Researcher") {
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

async function rowTag(
    page: BrowserPage,
    scope: string,
    id: number,
    type: "Chat" | "Worker" | "Pull" | "Researcher",
) {
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

            swatch.style.color = 'var(${type === "Chat" ? "--o-green" : type === "Pull" ? "--o-cyan" : "--o-blue"})';
            row.append(swatch);
            const color = getComputedStyle(tag).color === getComputedStyle(swatch).color;

            swatch.remove();

            return {
                text: tag.textContent.trim(),
                label: tag.getAttribute('aria-label'),
                title: tag.title,
                icon: Boolean(icon?.width > 0 && icon?.height > 0
                    && tag.querySelector('svg path')?.getAttribute('d')?.trim()),
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
        `${type} uses its ${type === "Chat" ? "green" : type === "Pull" ? "cyan" : "blue"} theme color`,
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

async function alignedRows(
    page: BrowserPage,
    scope: string,
    projectThreadId: number,
    otherId: number,
) {
    await until(
        () =>
            value<boolean>(
                page,
                `(() => {
                    const projectThread = document.querySelector('${scope} .session-row[data-id="${projectThreadId}"] .session').getBoundingClientRect();
                    const other = document.querySelector('${scope} .session-row[data-id="${otherId}"] .session').getBoundingClientRect();
                    const bar = document.querySelector('${scope} .session-items > .slide-y')?.getBoundingClientRect();

                    return Math.abs(projectThread.left - other.left) < 1
                        && Math.abs(projectThread.right - other.right) < 1
                        && (!bar || Math.abs(projectThread.left - bar.left) < 1);
                })()`,
            ),
        "project thread borders align with other rows and the active bar",
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
    "Projects UI: direct project threads, creation, typed chips, folds and live updates",
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

                writeFileSync(join(cwd, "fixture.txt"), "Disposable project checkout\n");
                execFileSync("git", ["init", "-b", "fixture-initial", cwd]);
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
                const model = scriptedModel();
                const app = await openApp(model, join(root, `projects-${viewport}-data`));
                const user = owner(app);
                // Standalone Workers represent existing Collab rows; migration itself is owned by app tests.
                const standaloneWorker = await app.commands.createSession(user, {
                    cwd,
                    title: "Existing Collab work",
                    threadType: "worker",
                    worktree: true,
                });
                const initialBranch = app.sessionMeta(standaloneWorker.id)?.worktree?.branch;

                assert.ok(initialBranch, "the initial Worker owns a real disposable worktree");
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
                        assert.equal(
                            await value(
                                connected,
                                `(() => {
                                const row = document.querySelector('${scope} .session-row[data-id="${standaloneWorker.id}"]');
                                const branch = [...row.querySelectorAll('.session-meta span')]
                                    .find(span => span.textContent.includes(${JSON.stringify(initialBranch)}));

                                return !row.closest('.work-item') && branch?.getBoundingClientRect().width > 16;
                            })()`,
                            ),
                            true,
                            "the first thread shows its worktree branch before any handoff or Work Item grouping",
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
                    await present(page, `${panel} ${projectPathField}`, false);
                    await button(page, `${panel} .project-form .session-path`, "Change");
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
                    await destination(page, cwd);
                    await closeDialog(page);
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

                    const projectStart = await options(page, scope, name, viewport === "mobile");

                    await button(page, projectStart, "New Session here…");
                    await present(page, `${panel} .session-destination`);
                    await destination(page, cwd);
                    const first = await start(page, app, "Worker");

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
                    await waitGroup(page, scope, name);
                    await waitGroup(peer, scope, name);
                    assert.equal(
                        await value(
                            page,
                            `(${group(scope, name)}).querySelectorAll(':scope > .group-body > div > .session-row').length`,
                        ),
                        1,
                        "a standalone Worker is a direct project row without another grouping level",
                    );
                    assert.equal(await rowTag(page, scope, first.id, "Worker"), false);
                    assert.equal(first.worktree, undefined);
                    assert.equal(
                        await value(
                            page,
                            `(() => {
                                const row = document.querySelector('${scope} .session-row[data-id="${first.id}"]');
                                const metadata = row.querySelector('.session-meta');
                                const branch = [...row.querySelectorAll('.session-meta span')]
                                    .find(span => span.textContent.includes('fixture-initial'));

                                return !row.closest('.work-item')
                                    && metadata?.textContent.includes(${JSON.stringify(cwd)})
                                    && branch?.getBoundingClientRect().width > 16;
                            })()`,
                        ),
                        true,
                        "an ordinary initial Worker shows its path and actual checkout branch without a Coop worktree or handoff",
                    );
                    await alignedRows(page, scope, first.id, standaloneWorker.id);
                    assert.equal(
                        await rowTag(page, scope, standaloneChat.id, "Chat"),
                        true,
                        "sharing a cwd never assigns a standalone Chat to the project",
                    );

                    if (viewport === "desktop") {
                        await click(
                            page,
                            `${scope} .session-row[data-id="${standaloneChat.id}"] .session`,
                        );
                        await keyboardOptions(page, scope, name, true);
                        await page.hover({ selector: groupHead(scope, name) });
                        await page.click({
                            selector: `${scope} [aria-label=${JSON.stringify(`New Session in ${name}`)}]`,
                        });
                    } else {
                        // A hold can hand contact to its own sheet without a ghost activation.
                        await heldOptions(page, scope, name, true);
                        await page.setViewport({ ...VIEWPORTS.mobile, width: 820, height: 600 });
                        await groupControls(page, scope, name, true);
                        await heldOptions(page, scope, name, true);
                        await page.setViewport(VIEWPORTS.mobile);
                        const surface = await options(page, scope, name, true);

                        await button(page, surface, "New Session here…");
                    }

                    await destination(page, cwd);
                    await button(page, `${panel} .session-path`, "Change");
                    await present(page, `${panel} select[aria-label="Working location"]`);
                    await fill(page, `${panel} input[aria-label="Working directory"]`, override);
                    await button(page, `${panel} .session-path`, "Done");
                    await destination(page, override);
                    const second = await start(page, app, "Worker");

                    assert.equal(second.cwd, override);
                    assert.equal(second.projectId, project.id);
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
                    await destination(page, cwd);
                    await closeDialog(page);

                    await groupClick(page, scope, name, ".group-head");
                    await disclosure(page, scope, name, false);
                    await present(page, `${scope} .session-row[data-id="${standaloneChat.id}"]`);
                    await disclosure(peer, scope, name, true);
                    await groupClick(page, scope, name, ".group-head");
                    await disclosure(page, scope, name, true);
                    await present(page, `${scope} .session-row[data-id="${first.id}"]`);
                    await present(page, `${scope} .session-row[data-id="${second.id}"]`);
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
                        await waitGroup(reader, scope, name);
                        assert.equal(
                            await value(
                                reader,
                                `(${group(scope, name)}).querySelectorAll('.project-group-actions button').length`,
                            ),
                            0,
                            "viewers and scoped participants get no project mutation controls",
                        );
                    }

                    assert.equal(
                        await value(
                            participant,
                            `document.querySelector('${scope} .session-row[data-id="${second.id}"]') === null`,
                        ),
                        true,
                        "a scoped project catalogue never reveals sibling threads",
                    );
                    // Archived remains a project projection of the existing thread archive action.
                    await click(page, `${scope} .session-row[data-id="${first.id}"] .session`);
                    await click(page, '.topbar [aria-label="Menu"]');
                    await button(page, '[role="dialog"]', "Archive");
                    await until(
                        () => app.sessionMeta(first.id as ConversationId)?.archived === true,
                        "thread archived",
                    );
                    await present(page, `${scope} .new-button[aria-label="New session"]`);
                    await present(peer, `${scope} .session-row[data-id="${first.id}"]`, false);
                    await tab(page, scope, "Archived");
                    await waitGroup(page, scope, name);
                    await present(page, `${scope} .session-row[data-id="${first.id}"]`);
                    await click(page, `${scope} .session-row[data-id="${first.id}"] .session`);
                    await click(page, '.topbar [aria-label="Menu"]');
                    await button(page, '[role="dialog"]', "Unarchive");
                    await until(
                        () => app.sessionMeta(first.id as ConversationId)?.archived === false,
                        "thread restored",
                    );
                    await home(page, scope);
                    await tab(page, scope, "Projects");
                    await present(peer, `${scope} .session-row[data-id="${first.id}"]`);
                    await shot(page, `${viewport}-project-threads`);

                    await click(page, `${scope} .new-button[aria-label="New session"]`);
                    await button(page, panel, "Start a one-time chat");
                    const chat = await start(page, app, "Chat");

                    assert.equal(chat.threadType, "chat");
                    assert.equal(chat.projectId, undefined);
                    await home(page, scope);
                    assert.equal(await rowTag(page, scope, chat.id, "Chat"), true);
                    await present(peer, `${scope} .session-row[data-id="${chat.id}"]`);

                    for (const type of ["Pull", "Researcher"] as const) {
                        const threadType = type.toLowerCase();

                        await click(page, `${scope} .new-button[aria-label="New session"]`);
                        await button(page, panel, "Start a one-time chat");
                        await page.evaluate(`const field = document.querySelector('${panel} select[aria-label="Thread type"]');
                            field.value = '${threadType}';
                            field.dispatchEvent(new Event('change', { bubbles: true }));`);
                        const standalone = await start(page, app, type);

                        assert.equal(standalone.threadType, threadType);
                        assert.equal(standalone.projectId, undefined);
                        await home(page, scope);
                        assert.equal(await rowTag(page, scope, standalone.id, type), true);
                        await present(peer, `${scope} .session-row[data-id="${standalone.id}"]`);
                        await click(page, `${scope} .new-button[aria-label="New session"]`);
                        await chooseProject(page, name);
                        await page.evaluate(`const field = document.querySelector('${panel} select[aria-label="Thread type"]');
                            field.value = '${threadType}';
                            field.dispatchEvent(new Event('change', { bubbles: true }));`);
                        await shot(page, `${viewport}-project-${threadType}`);
                        const starter = await start(page, app, type);

                        assert.equal(starter.threadType, threadType);
                        assert.equal(starter.projectId, project.id);
                        assert.equal(starter.cwd, cwd);
                        await home(page, scope);
                        assert.equal(await rowTag(page, scope, starter.id, type), false);
                        await present(peer, `${scope} .session-row[data-id="${starter.id}"]`);
                    }

                    // Starter availability follows the current public profile catalogue, not old version sentinels.
                    const hello = app.hello.bind(app);

                    app.hello = async (supplied) => {
                        const result = await hello(supplied);

                        return {
                            ...result,
                            server: {
                                ...result.server,
                                agentProfiles: result.server.agentProfiles.filter((profile) =>
                                    ["worker", "chat"].includes(profile.id),
                                ),
                            },
                        };
                    };

                    try {
                        await page.reload();
                        await click(page, `${scope} .new-button[aria-label="New session"]`);
                        await chooseProject(page, name);
                        assert.deepEqual(
                            await value(
                                page,
                                `[...document.querySelectorAll('${panel} select[aria-label="Thread type"] option')].map(option => option.value)`,
                            ),
                            ["worker"],
                            "project starters offer only available non-Chat profiles",
                        );
                        await button(page, panel, "Start a one-time chat");
                        assert.equal(
                            await value(
                                page,
                                `[...document.querySelectorAll('${panel} button')].some(button => button.textContent.trim() === 'Start Chat' && !button.disabled)`,
                            ),
                            true,
                            "the advertised Chat starter remains available outside projects",
                        );
                        await closeDialog(page);
                    } finally {
                        app.hello = hello;
                    }

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
                                    at: sheet.at,
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
        let helperGate: typeof gate;
        const model = scriptedModel(async (request) => {
            const { text, role } = lastText(request as never);

            if (text.includes("Hold sidebar helper for geometry") && helperGate !== undefined) {
                helperGate.entered = true;
                await helperGate.wait;

                return fauxAssistantMessage("helper complete");
            }

            if (text.includes("held result with helper")) {
                return fauxAssistantMessage(
                    [
                        fauxToolCall("subagent", {
                            action: "spawn",
                            name: "sidebar-helper",
                            message: "Hold sidebar helper for geometry",
                        }),
                    ],
                    { stopReason: "toolUse" },
                );
            }

            if (
                (text.includes("held") ||
                    (helperGate && role === "toolResult" && text.includes("Started"))) &&
                gate !== undefined
            ) {
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

        const startHeld = async (withHelper = false) => {
            let release = () => {};

            const wait = new Promise<void>((resolve) => {
                release = resolve;
            });

            gate = { entered: false, wait, release };

            if (withHelper) {
                let releaseHelper = () => {};

                const helperWait = new Promise<void>((resolve) => {
                    releaseHelper = resolve;
                });

                helperGate = { entered: false, wait: helperWait, release: releaseHelper };
            }

            const { submissionId } = await app.commands.submit(id, owner(app), {
                text: withHelper ? "held result with helper" : "held result",
                requestId: crypto.randomUUID(),
            });

            await until(
                () =>
                    gate?.entered === true &&
                    app.isBusy(id) &&
                    (!withHelper || helperGate?.entered === true),
                "the model held mid-run with its real helper, when requested",
            );

            return async () => {
                helperGate?.release();
                release();
                await (await app.harness.submission(submissionId, context))!.wait(context);
                await until(
                    () =>
                        !app.isBusy(id) &&
                        (!withHelper || app.subagents().every((agent) => !agent.busy)),
                    "the parent and any held helper have completed",
                );
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

            // A real held child publishes its count while the standalone parent is also busy.
            finish = await startHeld(true);
            await page.setViewport(VIEWPORTS.mobile);
            await spinner(page, mobile);
            await present(page, `${mobile} .session-row[data-id="${id}"] .session-fork`);
            assert.equal(
                await value(
                    page,
                    `(() => {
                    const side = document.querySelector('${mobile} .session-row[data-id="${id}"] .session-side');
                    const fork = side.querySelector('.session-fork').getBoundingClientRect();
                    const busy = side.querySelector('.spinner').getBoundingClientRect();
                    const time = side.querySelector('.session-time').getBoundingClientRect();
                    const center = rect => (rect.top + rect.bottom) / 2;

                    return side.querySelector('.session-fork').textContent.trim() === '1'
                        && fork.right < busy.left && busy.right < time.left
                        && Math.abs(center(busy) - center(fork)) < 1
                        && Math.abs(center(busy) - center(time)) < 1;
                })()`,
                ),
                true,
                "the busy spinner follows the real helper count and shares the badge/time vertical center",
            );
            await finish();
            assert.deepEqual(
                pages
                    .flatMap((connected) => connected.logs())
                    .filter((entry) => entry.level === "error"),
                [],
                "no browser errors or module-cycle failures",
            );
        } finally {
            helperGate?.release();
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
