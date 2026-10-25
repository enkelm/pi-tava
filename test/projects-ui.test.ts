// Authoring gate: real UI choices must preserve project membership and reach durable state.
// Regressions: lost project controls, extra grouping levels, labelled sidebar chips and stale peers.
// App tests own storage/access; this owns browser disclosure, forms and event delivery.
// Sidebar regressions: row indentation, busy-loader drift, active idle accent and lost result-read marks.
// Real run completion and browser storage/visibility events own the result lifecycle; app tests do not render it.
// Menu contracts share this fixture: misplaced/right-click navigation, focus loss, omitted actions,
// coarse-pointer hover-only traps and thread type icons are not reached by app tests.
// Compact header geometry owns distinct controls and long default-agent names without hiding projects.
// Home geometry owns sidebar/page versus compact-sheet layout and actual-pane composition.
// Default interacted and explicit setup lifecycles retain one form while resizing, including coarse tablets.
// Mobile project + and project-route creation preserve context without replacing the landing list/route.
// Project chrome has no redundant topbar; phone content Back remains a real 44px escape route.
// The PiPs entry must render the native secondary surface beside an aligned primary New Session.
// Session-moves UI owns thread menus; this covers project menus through DOM and trusted input.
// Pull/Researcher starters own rendered selection and type indicators; backend tests do not render them.
// Exact-Chat chrome uses a disposable filtered catalogue to own rendered vertical controls,
// leaf alignment and reduced-motion behavior; projection tests own actual placement decisions.
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

const panel = '.home-creation-viewport:not([hidden]) [data-part="home"]';
// Native drafts remain mounted in hidden wrappers; only the disclosed flow is interactive.
const flow = `${panel} :is(.home-work-options, .home-one-time-options):not([hidden]) .project-session-flow`;
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

async function rested(page: BrowserPage) {
    await page.evaluate(`await Promise.all(document.getAnimations()
        .filter(animation => Number.isFinite(animation.effect?.getComputedTiming().endTime))
        .map(animation => animation.finished.catch(() => {})))`);
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
        (section.querySelector(':scope > .project-group-head .project-title')
            ?? section.querySelector(':scope > .project-group-head .group-name'))?.textContent.trim()
                === ${JSON.stringify(name)})`;
}

async function waitGroup(page: BrowserPage, scope: string, name: string) {
    await showSessions(page, scope);
    await until(() => value<boolean>(page, `Boolean(${group(scope, name)})`), `project ${name}`);
}

async function groupClick(page: BrowserPage, scope: string, name: string, selector: string) {
    await waitGroup(page, scope, name);
    await page.evaluate(
        `(${group(scope, name)}).querySelector(${JSON.stringify(selector)}).click()`,
    );
}

function groupHead(scope: string, name: string) {
    return `${scope} .project-group-head > .project-open[title=${JSON.stringify(name)}]`;
}

function groupDisclosure(scope: string, name: string) {
    return `${scope} .project-group-head > .project-disclosure[aria-label$=${JSON.stringify(` ${name}`)}]`;
}

async function showSessions(page: BrowserPage, scope: string) {
    if (
        scope.startsWith(".home-list") &&
        !(await value<boolean>(page, `Boolean(document.querySelector('${scope}'))`))
    ) {
        await click(page, ':is(.project-view-content, .topbar) [aria-label="Back to sessions"]');
    }

    await present(page, scope);
}

function optionsSurface(name: string, mobile: boolean) {
    return `[role="${mobile ? "dialog" : "menu"}"][aria-label=${JSON.stringify(name)}]`;
}

async function options(page: BrowserPage, scope: string, name: string, mobile: boolean) {
    await waitGroup(page, scope, name);
    const before = await value<string>(page, "location.pathname");
    const expanded = await value<string>(
        page,
        `document.querySelector(${JSON.stringify(groupDisclosure(scope, name))}).getAttribute('aria-expanded')`,
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
            `document.querySelector(${JSON.stringify(groupDisclosure(scope, name))}).getAttribute('aria-expanded')`,
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
        `document.querySelector(${JSON.stringify(groupDisclosure(scope, name))}).getAttribute('aria-expanded')`,
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
            `document.querySelector(${JSON.stringify(groupDisclosure(scope, name))}).getAttribute('aria-expanded')`,
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
    agentName?: string,
) {
    // Approved compact navigation keeps + discoverable without hover, removes inline Edit/count,
    // and reserves separate native buttons for folding, opening the project and creating work.
    await waitGroup(page, scope, name);

    if (agentName !== undefined) {
        await until(
            () =>
                value<boolean>(
                    page,
                    `(${group(scope, name)}).querySelector('.project-agent-name')?.textContent === ${JSON.stringify(agentName)}`,
                ),
            "the committed default agent reaches the project header",
        );
        const identity = await value<{
            project: string;
            projectVisible: boolean;
            agentTruncated: boolean;
            contained: boolean;
        }>(
            page,
            `(() => {
                const header = (${group(scope, name)}).querySelector(':scope > .project-group-head');
                const open = header.querySelector('.project-open');
                const label = open.querySelector('.group-name').getBoundingClientRect();
                const project = open.querySelector('.project-title');
                const title = project.getBoundingClientRect();
                const agent = open.querySelector('.project-agent-name');
                const agentBounds = agent.getBoundingClientRect();
                const style = getComputedStyle(agent);

                return {
                    project: project.textContent.trim(),
                    projectVisible: title.width >= 32 && title.height > 0
                        && title.left >= agentBounds.right && title.right <= label.right + 1,
                    agentTruncated: agent.clientWidth > 0 && agent.scrollWidth > agent.clientWidth + 1
                        && style.overflowX === 'hidden' && style.textOverflow === 'ellipsis',
                    contained: header.scrollWidth <= header.clientWidth + 1
                        && open.scrollWidth <= open.clientWidth + 1
                        && agentBounds.left >= label.left - 1
                        && document.documentElement.scrollWidth <= innerWidth,
                };
            })()`,
        );

        assert.equal(identity.project, name, "the project title excludes the default-agent prefix");
        assert.equal(
            identity.projectVisible,
            true,
            "a long agent name leaves visible space for the actual project title",
        );
        assert.equal(identity.agentTruncated, true, "the long agent name is ellipsized first");
        assert.equal(identity.contained, true, "the compact header never overflows its controls");
    }

    await page.input([{ type: "mouse", action: "move", x: 1270, y: 790 }]);
    await page.evaluate(`document.querySelector('${scope} .new-button').focus()`);
    assert.equal(
        await value(
            page,
            `(() => {
                const header = (${group(scope, name)}).querySelector(':scope > .project-group-head');
                const collapse = header.querySelector('.project-disclosure').getBoundingClientRect();
                const open = header.querySelector('.project-open');
                const title = open.getBoundingClientRect();
                const createButton = header.querySelector('.project-create');
                const create = createButton.getBoundingClientRect();
                const label = header.querySelector('.group-name').getBoundingClientRect();
                let visible = true;

                for (let element = createButton; element; element = element.parentElement) {
                    const style = getComputedStyle(element);

                    visible &&= style.display !== 'none' && style.visibility !== 'hidden' && Number(style.opacity) > 0;
                }

                return visible && collapse.width > 0 && collapse.right <= title.left
                    && label.width > 0 && title.right <= create.left + 1
                    && create.width >= 40 && create.height >= ${mobile ? 44 : 40}
                    && !open.hasAttribute('aria-expanded')
                    && !header.querySelector('.group-count, .project-edit')
                    && ![...header.querySelectorAll('button')]
                        .some(button => button.getAttribute('aria-label') === ${JSON.stringify(`Edit ${name}`)});
            })()`,
        ),
        true,
        "compact project controls fit in order and + stays visible without hover on mouse and touch",
    );
    await page.press("Tab");
    await page.evaluate(
        `document.querySelector(${JSON.stringify(groupHead(scope, name))}).focus()`,
    );
    await page.press("Tab");
    assert.equal(
        await value(
            page,
            `document.activeElement === (${group(scope, name)}).querySelector('.project-create')`,
        ),
        true,
        "keyboard navigation reaches the always-visible New Session control after the project link",
    );
}

async function disclosure(page: BrowserPage, scope: string, name: string, expanded: boolean) {
    await until(
        () =>
            value<boolean>(
                page,
                `(() => {
                    const section = ${group(scope, name)};
                    const head = section.querySelector(':scope > .project-group-head .project-disclosure');
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

async function leaveCreation(page: BrowserPage, scope: string) {
    if (scope.startsWith(".home-list")) {
        await page.click({
            selector:
                '.home-creation-sheet[data-sheet="home-creation"] .sheet-head [aria-label="Close"]',
        });
        await present(page, ".home-creation-sheet", false);
        await home(page, scope);

        return;
    }

    // Desktop Home remains a page. Collapse the shared alternatives without creating anything.
    const alternatives = `[...document.querySelectorAll('${panel} button')]
        .find(element => element.textContent.trim() === 'Other ways to start'
            && element.getAttribute('aria-expanded') === 'true')`;

    if (await value<boolean>(page, `Boolean(${alternatives})`)) {
        await page.evaluate(`(${alternatives}).click()`);
    }

    await home(page, scope);
}

async function home(page: BrowserPage, scope: string) {
    await showSessions(page, scope);
    await present(page, `${scope} .new-button[aria-label="New session"]`);
}

async function startOptions(page: BrowserPage, action: "New Work Item" | "One-time Chat") {
    await present(page, panel);
    const disclosure = `[...document.querySelectorAll('${panel} button')]
        .find(element => element.textContent.trim() === 'Other ways to start')`;

    if (await value<boolean>(page, `(${disclosure}).getAttribute('aria-expanded') === 'false'`)) {
        await page.evaluate(`(${disclosure}).click()`);
    }

    await button(page, panel, action);
    await present(page, `${flow} .session-destination`);
}

async function workOptions(page: BrowserPage) {
    await startOptions(page, "New Work Item");
}

async function chooseProject(page: BrowserPage, name: string) {
    await button(page, `${panel} .home-project-choices`, name);
    assert.equal(
        await value(
            page,
            `document.querySelector('${panel} .home-project-choice[aria-pressed=true] .home-project-name')?.textContent.trim()`,
        ),
        name,
        "Home selects the project before choosing a native start flow",
    );
    await workOptions(page);
}

async function homeComposition(page: BrowserPage) {
    await present(page, `${panel} .home-session-choice`);
    await rested(page);
    const layout = await value<{
        wide: boolean;
        sideBySide: boolean;
        stacked: boolean;
        contained: boolean;
    }>(
        page,
        `(() => {
            const home = document.querySelector('${panel}');
            const list = home.querySelector('.home-project-list').getBoundingClientRect();
            const actions = home.querySelector('.home-detail').getBoundingClientRect();
            const visible = list.width > 100 && list.height > 0
                && actions.width > 100 && actions.height > 0;

            return {
                wide: home.getBoundingClientRect().width >= 720
                    && (!home.closest('[role="dialog"]') || !!home.closest('.sheet.wide')),
                sideBySide: visible && actions.left >= list.right + 24
                    && Math.abs(actions.top - list.top) < 2
                    && Math.min(actions.bottom, list.bottom) > Math.max(actions.top, list.top),
                stacked: visible && actions.top >= list.bottom + 16
                    && Math.abs(actions.left - list.left) < 2
                    && Math.abs(actions.width - list.width) < 2,
                contained: home.scrollWidth <= home.clientWidth + 1
                    && document.documentElement.scrollWidth <= innerWidth,
            };
        })()`,
    );

    assert.equal(
        layout.wide ? layout.sideBySide : layout.stacked,
        true,
        layout.wide
            ? "a wide Home pane places project actions alongside the project list"
            : "a narrow actual pane or compact sheet stacks project actions, even on a wide tablet",
    );
    assert.equal(layout.contained, true, "Home composition stays within its available pane");

    return layout;
}

async function defaultHomeResize(page: BrowserPage) {
    // This starts on default Home, without New Session's explicit creation intent.
    const draft = "Unfinished tablet project";

    await present(page, panel);
    await page.evaluate(`window.defaultTabletSetup = document.querySelector('${panel}')`);
    await button(page, panel, "New Project");
    await fill(page, `${panel} ${projectNameField}`, draft);

    for (const viewport of [
        VIEWPORTS.tablet,
        { ...VIEWPORTS.tablet, width: 1180, height: 820 },
        { ...VIEWPORTS.tablet, width: 768, height: 1024 },
        { ...VIEWPORTS.tablet, width: 767, height: 1024 },
        { ...VIEWPORTS.tablet, width: 540, height: 900 },
        VIEWPORTS.desktop,
    ]) {
        await page.setViewport(viewport);
        const compact = viewport.width < 768;

        await until(
            () =>
                value<boolean>(
                    page,
                    `document.querySelector('.home-creation-page .home-creation-sheet')?.getAttribute('role') === ${compact ? "'dialog'" : "null"}`,
                ),
            "Home's native shell follows available width, not its coarse tablet pointer",
        );
        await rested(page);
        const layout = await value<{
            same: boolean;
            draft: string;
            setups: number;
            sidebar: boolean;
            page: boolean;
            list: boolean;
            bottom: boolean;
            contained: boolean;
            coarse: boolean;
            path: string;
        }>(
            page,
            `(() => {
            const home = document.querySelector('${panel}');
            const sheet = home.closest('.sheet');
            const bounds = sheet.getBoundingClientRect();
            const side = document.querySelector('.sidebar').getBoundingClientRect();
            const pane = document.querySelector('.pane').getBoundingClientRect();
            const list = document.querySelector('.home-list > .sessions')?.getBoundingClientRect();
            const modal = sheet.getAttribute('role') === 'dialog';

            return {
                same: home === window.defaultTabletSetup,
                draft: home.querySelector('${projectNameField}').value,
                setups: document.querySelectorAll('[data-part="home"]').length,
                sidebar: side.width >= 200 && side.height > 0 && side.right <= pane.left + 1,
                page: !modal && bounds.width > 0 && bounds.left >= pane.left,
                list: !!list && list.width >= innerWidth - 2 && list.height > 0,
                bottom: modal && Math.abs(bounds.bottom - innerHeight) < 2,
                contained: bounds.width > 0 && bounds.height > 0
                    && bounds.top >= 0 && bounds.left >= 0
                    && bounds.right <= innerWidth + 1 && bounds.bottom <= innerHeight + 1
                    && home.scrollWidth <= home.clientWidth + 1
                    && document.documentElement.scrollWidth <= innerWidth,
                coarse: matchMedia('(pointer: coarse)').matches,
                path: location.pathname,
            };
        })()`,
        );

        assert.deepEqual(
            layout,
            {
                same: true,
                draft,
                setups: 1,
                sidebar: !compact,
                page: !compact,
                list: compact,
                bottom: compact,
                contained: true,
                coarse: viewport.mobile,
                path: "/",
            },
            `${viewport.width}px: interacted default Home retains one form with sidebar/page at 768+ and list/bottom below`,
        );
    }

    await button(page, `${panel} .project-form`, "Cancel");
}

async function destination(page: BrowserPage, cwd: string) {
    await workOptions(page);
    await present(page, `${flow} .session-destination .check input[type="checkbox"]`);
    assert.equal(
        await value(
            page,
            `document.querySelector('${flow} select[aria-label="Working location"]')`,
        ),
        null,
        "starting from a project does not mount destination or SSH controls until Change",
    );
    assert.equal(
        await value(page, `document.querySelector('${flow} .session-path .mono').title`),
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
                `/^\\/s\\/\\d+$/.test(location.pathname) && document.querySelector('${panel}') === null`,
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

async function chatRowGeometry(page: BrowserPage, scope: string) {
    // Only this disposable page's catalogue changes; no native data or model work is mutated.
    await page.evaluate(`
        const { store } = await import('/store.js');
        const fields = ['projects', 'sessions', 'namedAgents'];

        window.chatGeometryBefore = {
            state: Object.fromEntries(fields.map(key => [key, store.state[key]])),
            motion: document.documentElement.getAttribute('data-motion'),
        };
        store.set({
            projects: [{ id: 'chat-geometry', name: 'Chat geometry' }, { id: 'chat-elsewhere', name: 'Elsewhere' }],
            namedAgents: [{
                agentId: 'geometry-pip', name: 'Geometry PiP', busy: true, managing: true,
                chats: [
                    { id: 960001, title: 'Waiting manager', projectId: 'chat-geometry', busy: false, managing: true, waiting: true },
                    { id: 960002, title: 'Idle leaf', projectId: 'chat-geometry', busy: false, managing: false },
                    { id: 960003, title: 'Other leaf', projectId: 'chat-elsewhere', busy: false, managing: false },
                ],
            }],
            sessions: [
                { id: 960011, title: 'Co-located work', workItemId: 'chat-geometry-work', activeThreadId: 960011, groupingParentChatId: 960001,
                    projectId: 'chat-geometry', updatedAt: 1, busy: true,
                    supervisor: { conversationId: 960021, parentChatId: 960001 } },
                { id: 960012, title: 'Explicitly moved work', workItemId: 'chat-moved-work', activeThreadId: 960012, groupingParentChatId: 960001,
                    projectId: 'chat-elsewhere', updatedAt: 2,
                    supervisor: { conversationId: 960022, parentChatId: 960001 } },
            ],
        });
    `);
    const parent = `${scope} .project-chat[data-chat-id="960001"]`;
    const leaf = `${scope} .project-chat[data-chat-id="960002"]`;

    try {
        await present(page, `${parent} .project-chat-disclosure .named-agent-avatar svg`);
        await present(page, `${leaf} .project-chat-open .named-agent-avatar img`);
        await page.evaluate(
            `document.querySelector(${JSON.stringify(parent)}).scrollIntoView({ block: 'center' })`,
        );
        await rested(page);
        assert.equal(
            await value(
                page,
                `(() => {
                const parent = document.querySelector(${JSON.stringify(parent)});
                const leaf = document.querySelector(${JSON.stringify(leaf)});
                const disclosure = parent.querySelector('.project-chat-disclosure');
                const face = disclosure.querySelector('.named-agent-avatar');
                const arrow = disclosure.querySelector(':scope > .icon');
                const open = parent.querySelector('.project-chat-open');
                const title = open.querySelector('.project-chat-title').getBoundingClientRect();
                const target = disclosure.getBoundingClientRect();
                const avatar = face.getBoundingClientRect();
                const chevron = arrow.getBoundingClientRect();
                const leafOpen = leaf.querySelector('.project-chat-open');
                const leafFace = leaf.querySelector('.named-agent-avatar').getBoundingClientRect();
                const ids = [...document.querySelectorAll('${scope} .project-chat')].map(row => Number(row.dataset.chatId));

                return JSON.stringify(ids) === JSON.stringify([960001, 960002, 960003])
                    && !parent.querySelector('button button')
                    && !parent.querySelector(':scope > .project-chat-head .spinner, :scope > .project-chat-head .project-chat-activity')
                    && disclosure.tagName === 'BUTTON' && open.tagName === 'BUTTON'
                    && !disclosure.classList.contains('work-item-disclosure')
                    && ['static', 'relative'].includes(getComputedStyle(disclosure).position)
                    && getComputedStyle(disclosure).flexDirection === 'column'
                    && face.nextElementSibling === arrow && avatar.bottom <= chevron.top
                    && Math.abs((avatar.left + avatar.right - chevron.left - chevron.right) / 2) < 1
                    && target.height >= 44 && target.width >= (matchMedia('(any-pointer: coarse)').matches ? 44 : 32)
                    && target.right <= title.left && !open.querySelector('.named-agent-avatar')
                    && document.elementFromPoint((target.left + target.right) / 2, (target.top + target.bottom) / 2)?.closest('button') === disclosure
                    && open.getAttribute('aria-description') === 'Managing work'
                    && !leaf.querySelector('.project-chat-disclosure, .project-chat-items, .group-body, .spinner')
                    && leafFace.left - leafOpen.getBoundingClientRect().left <= 12
                    && !leafOpen.hasAttribute('aria-description');
            })()`,
            ),
            true,
            "one leading Avatar sits above the chevron; the idle leaf has only its Avatar and no reserved disclosure slot",
        );
        await click(page, `${parent} .project-chat-disclosure`);
        assert.equal(
            await value(
                page,
                `document.querySelector('${parent} .group-body').inert
                && document.querySelector('${parent} .project-chat-disclosure').getAttribute('aria-expanded') === 'false'
                && !document.querySelector('${scope} [data-project-id="chat-elsewhere"] [data-work-item-id="chat-moved-work"]').closest('.project-chat')`,
            ),
            true,
            "folding the exact Chat leaves explicitly moved work in its actual project",
        );
        await click(page, `${parent} .project-chat-disclosure`);
        await page.evaluate("document.documentElement.dataset.motion = 'reduced'");
        await rested(page);
        assert.equal(
            await value(
                page,
                `(() => {
                const parent = document.querySelector(${JSON.stringify(parent)});
                const face = parent.querySelector('.named-agent-avatar');

                return parent.querySelector('.project-chat-open').getAttribute('aria-description') === 'Managing work'
                    && face.getAnimations({ subtree: true }).every(animation =>
                        animation.playState !== 'running' || animation.effect.getTiming().iterations !== Infinity);
            })()`,
            ),
            true,
            "reduced motion stops infinite Avatar motion without losing exact-Chat activity text",
        );
    } finally {
        await page.evaluate(`
            const { store } = await import('/store.js');
            const before = window.chatGeometryBefore;

            if (before.motion === null) {
                document.documentElement.removeAttribute('data-motion');
            } else {
                document.documentElement.setAttribute('data-motion', before.motion);
            }

            store.set(before.state);
            delete window.chatGeometryBefore;
        `);
    }
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
                const scope =
                    viewport === "mobile" ? ".home-list > .sessions" : ".sidebar .sessions";
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
                        await home(connected, scope);
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
                            `(() => {
                                const entry = document.querySelector('${scope} .session-entry');
                                const people = entry.querySelector('[aria-label="Named agents (PiPs)"]');
                                const create = entry.querySelector('[aria-label="New session"]');
                                const reference = document.createElement('button');

                                reference.className = 'button';
                                entry.append(reference);
                                const actual = getComputedStyle(people);
                                const native = getComputedStyle(reference);
                                const secondary = ['backgroundColor', 'color', 'borderTopWidth', 'borderTopStyle',
                                    'borderTopColor', 'borderLeftWidth', 'borderLeftColor', 'borderRadius']
                                    .every(property => actual[property] === native[property]);

                                reference.remove();
                                const target = people.getBoundingClientRect();
                                const primary = create.getBoundingClientRect();

                                return secondary && people.tagName === 'BUTTON' && !!people.querySelector('svg')
                                    && !people.classList.contains('primary') && create.classList.contains('primary')
                                    && target.width >= 44 && target.height >= 44 && primary.height >= 44
                                    && Math.abs(primary.top - target.top) < 1
                                    && Math.abs(primary.bottom - target.bottom) < 1;
                            })()`,
                        ),
                        true,
                        "PiPs uses the native secondary surface, not a divider-only icon, beside a 44px primary New Session",
                    );
                    assert.equal(
                        await value(
                            page,
                            `[...document.querySelectorAll('${scope} button')]
                                .some(button => button.textContent.trim() === 'New Project')`,
                        ),
                        false,
                        "the sidebar has no standalone New Project button",
                    );

                    if (viewport === "desktop") {
                        await defaultHomeResize(page);
                        assert.equal(
                            app.sessions().length,
                            2,
                            "resizing an unsaved default Home form creates no work",
                        );
                    }

                    await click(page, `${scope} .new-button[aria-label="New session"]`);
                    await present(page, panel);
                    await button(page, panel, "New Project");
                    await fill(page, `${panel} ${projectNameField}`, initialName);
                    await present(page, `${panel} ${projectPathField}`, false);
                    await button(page, `${panel} .project-form .session-path`, "Change");
                    await fill(page, `${panel} ${projectPathField}`, cwd);
                    await button(page, `${panel} .project-form`, "Create project");
                    await chooseProject(page, initialName);
                    await homeComposition(page);

                    if (viewport === "desktop") {
                        await page.evaluate(
                            `window.desktopSetup = document.querySelector('${panel}')`,
                        );

                        for (const resized of [
                            VIEWPORTS.tablet,
                            { ...VIEWPORTS.tablet, width: 1180, height: 820 },
                            { ...VIEWPORTS.tablet, width: 768, height: 1024 },
                            { ...VIEWPORTS.tablet, width: 767, height: 1024 },
                            { ...VIEWPORTS.tablet, width: 540, height: 900 },
                            VIEWPORTS.desktop,
                        ]) {
                            await page.setViewport(resized);
                            await present(page, panel);
                            assert.equal(
                                await value(
                                    page,
                                    `window.desktopSetup === document.querySelector('${panel}')
                                        && document.querySelectorAll('[data-part="home"]').length === 1
                                        && document.querySelector('${panel} .home-project-choice[aria-pressed=true] .home-project-name')?.textContent.trim() === ${JSON.stringify(initialName)}
                                        && location.pathname === '/'`,
                                ),
                                true,
                                "explicit setup keeps the exact form and project through tablet and split layouts",
                            );
                            const composition = await homeComposition(page);

                            if (resized.width === 820 || resized.width === 768) {
                                assert.equal(
                                    composition.wide,
                                    false,
                                    "the persistent sidebar leaves a narrow Home pane that stacks on portrait tablets",
                                );
                            }

                            if (resized.width < 768) {
                                await present(page, ".home-list > .sessions");
                                await present(
                                    page,
                                    ".home-creation-page .home-creation-sheet.bottom-sheet",
                                );
                            }
                        }
                    }

                    await leaveCreation(page, scope);
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
                                const header = (${group(scope, name)}).querySelector('.project-group-head');
                                const open = header.querySelector('.project-open');
                                const collapse = header.querySelector('.project-disclosure');
                                const chevron = collapse.querySelector('.group-disclosure').getBoundingClientRect();
                                const label = open.querySelector('.group-name').getBoundingClientRect();

                                return collapse.querySelectorAll('svg').length === 1
                                    && !open.hasAttribute('aria-expanded')
                                    && chevron.right <= label.left;
                            })()`,
                        ),
                        true,
                        "projects separate their leading collapse button from project navigation",
                    );
                    await groupClick(page, scope, name, ".project-open");
                    await present(page, `.project-view[aria-label=${JSON.stringify(name)}]`);
                    assert.equal(
                        await value(page, `(await import('/store.js')).store.state.projectId`),
                        project.id,
                        "the project title opens the focused project route instead of folding its rows",
                    );

                    assert.equal(
                        await value(
                            page,
                            `(() => {
                                const pane = document.querySelector('[data-part="pane"]');
                                const project = pane.querySelector('.project-view-content');
                                const back = project.querySelector('[aria-label="Back to sessions"]');
                                const bounds = back.getBoundingClientRect();

                                return !pane.querySelector('.topbar, [aria-label="Menu"], [aria-label="Open sessions"]')
                                    && project.querySelector('h1')?.textContent.trim() === ${JSON.stringify(name)}
                                    && project.querySelectorAll('.project-view-actions button').length === 2
                                    && ${viewport === "mobile" ? "bounds.width >= 44 && bounds.height >= 44" : "bounds.width === 0 && bounds.height === 0"};
                            })()`,
                        ),
                        true,
                        "the project keeps its real heading/actions, no redundant route bar, and only phone content Back occupies space",
                    );

                    if (viewport === "mobile") {
                        const projectPath = `/projects/${project.id}`;

                        await button(page, ".project-view-actions", "New Session");
                        await present(page, '.home-creation-sheet[data-sheet="home-creation"]');
                        assert.equal(await value(page, "location.pathname"), projectPath);
                        assert.equal(
                            await value(
                                page,
                                `document.querySelector('.home-project-choice[aria-pressed=true] .home-project-name')?.textContent.trim()`,
                            ),
                            name,
                            "project-page New Session opens the shared sheet with project context",
                        );
                        await present(page, `.project-view[aria-label=${JSON.stringify(name)}]`);
                        await page.press("Escape");
                        await present(page, ".home-creation-sheet", false);
                        assert.equal(
                            await value(page, "location.pathname"),
                            projectPath,
                            "dismissing creation reveals the same project route",
                        );
                    }

                    await waitGroup(page, scope, name);
                    await disclosure(page, scope, name, true);

                    if (viewport === "desktop") {
                        assert.equal(
                            await value(
                                page,
                                `document.querySelector(${JSON.stringify(groupHead(scope, name))}).getAttribute('aria-current')`,
                            ),
                            "page",
                            "the compact sidebar marks the focused project without changing disclosure state",
                        );
                    }

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
                    await leaveCreation(page, scope);
                    assert.equal(app.sessions().length, 2);

                    const headerAgentName =
                        "A deliberately long named agent identity for compact project headings";
                    const headerAgent = await app.pip.agents.createIdentity(user, {
                        requestId: `long-header-agent-${viewport}`,
                        name: headerAgentName,
                    });

                    await app.projects.update(user, project.id, {
                        defaultAgentId: headerAgent.agentId,
                    });

                    try {
                        await groupControls(
                            page,
                            scope,
                            name,
                            viewport === "mobile",
                            headerAgentName,
                        );
                        assert.equal(
                            app.sessions().length,
                            2,
                            "creating and assigning a default identity starts no conversation",
                        );
                    } finally {
                        await app.projects.update(user, project.id, { defaultAgentId: null });
                    }

                    await until(
                        () =>
                            value<boolean>(
                                page,
                                `(${group(scope, name)}).querySelector('.project-agent-name') === null`,
                            ),
                        "clearing the temporary default restores the remaining project fixture",
                    );

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
                    await destination(page, cwd);
                    const first = await start(page, app, "Worker");

                    assert.equal(first.projectId, project.id);
                    assert.equal(first.cwd, cwd);
                    assert.equal(first.threadType, "worker");

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
                        await page.setViewport({ ...VIEWPORTS.tablet, width: 540, height: 600 });
                        await groupControls(page, scope, name, true);
                        await heldOptions(page, scope, name, true);
                        await page.setViewport(VIEWPORTS.mobile);
                        await page.click({
                            selector: `${scope} [aria-label=${JSON.stringify(`New Session in ${name}`)}]`,
                        });
                        await present(page, '.home-creation-sheet[data-sheet="home-creation"]');
                        assert.equal(
                            await value(page, "location.pathname"),
                            "/",
                            "project + opens creation above the landing list instead of navigating",
                        );
                        assert.equal(
                            await value(
                                page,
                                `document.querySelector('.home-project-choice[aria-pressed=true] .home-project-name')?.textContent.trim()`,
                            ),
                            name,
                            "the mobile + keeps its exact project selected",
                        );
                        await present(page, scope);
                    }

                    await destination(page, cwd);
                    const worktreeChoice = `${flow} .session-destination .check input[type="checkbox"]`;

                    await click(page, worktreeChoice);
                    await button(page, `${flow} .session-path`, "Change");
                    await present(page, `${flow} select[aria-label="Working location"]`);
                    assert.equal(
                        await value(
                            page,
                            `(() => {
                            const check = document.querySelector(${JSON.stringify(worktreeChoice)});
                            const options = document.querySelector('${flow} .workspace-field-options');

                            return check.checked &&
                                check.closest("label").getBoundingClientRect().top >= options.getBoundingClientRect().bottom &&
                                document.querySelectorAll(${JSON.stringify(worktreeChoice)}).length === 1;
                        })()`,
                        ),
                        true,
                        "the selected worktree checkbox remains once below the expanded directory controls",
                    );
                    await fill(page, `${flow} input[aria-label="Working directory"]`, override);
                    await page.evaluate(`const type = document.querySelector('${flow} select[aria-label="Thread type"]');
                        type.value = 'researcher'; type.dispatchEvent(new Event('change', { bubbles: true }));`);
                    const beforeCollapse = app.sessions().length;

                    await button(page, panel, "Other ways to start");
                    await present(page, `${flow} .session-destination`, false);
                    await button(page, panel, "Other ways to start");
                    await button(page, panel, "New Work Item");
                    await present(page, `${flow} input[aria-label="Working directory"]`);
                    assert.deepEqual(
                        await value(
                            page,
                            `({
                            cwd: document.querySelector('${flow} input[aria-label="Working directory"]').value,
                            worktree: document.querySelector(${JSON.stringify(worktreeChoice)}).checked,
                            profile: document.querySelector('${flow} select[aria-label="Thread type"]').value,
                        })`,
                        ),
                        { cwd: override, worktree: true, profile: "researcher" },
                        "collapsing and reopening Work Item options retains the native workspace, worktree and profile draft",
                    );
                    assert.equal(
                        app.sessions().length,
                        beforeCollapse,
                        "disclosure changes create no work",
                    );
                    await page.evaluate(`const type = document.querySelector('${flow} select[aria-label="Thread type"]');
                        type.value = 'worker'; type.dispatchEvent(new Event('change', { bubbles: true }));`);
                    await button(page, `${flow} .session-path`, "Done");
                    await destination(page, override);
                    assert.equal(
                        await value(
                            page,
                            `document.querySelector(${JSON.stringify(worktreeChoice)}).checked`,
                        ),
                        true,
                        "collapsing directory controls retains the visible worktree choice",
                    );
                    await click(page, worktreeChoice);
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
                    await button(page, `${flow} .session-path`, "Change");
                    await fill(page, `${flow} input[aria-label="Working directory"]`, override);
                    await click(page, `${flow} .session-destination .check input[type="checkbox"]`);
                    const remoteName = `Remote defaults ${viewport}`;
                    const remoteCwd = "/srv/remote-project";
                    const remoteHost = "workspace-fixture.invalid";

                    await app.projects.create(user, {
                        name: remoteName,
                        cwd: remoteCwd,
                        location: { kind: "ssh", host: remoteHost },
                        requestId: `remote-draft-${viewport}`,
                    });
                    await button(page, `${panel} .home-project-choices`, remoteName);
                    await present(page, `${flow} .session-destination`, false);
                    await workOptions(page);
                    await until(
                        () =>
                            value(
                                page,
                                `document.querySelector('${flow} .session-path .mono')?.title === ${JSON.stringify(`${remoteHost} · ${remoteCwd}`)}`,
                            ),
                        "the embedded native panel adopts the selected SSH project",
                    );
                    assert.deepEqual(
                        await value(
                            page,
                            `({
                            cwd: document.querySelector('${flow} .session-path .mono').title,
                            worktree: document.querySelector('${flow} .session-destination .check input[type="checkbox"]').checked,
                        })`,
                        ),
                        { cwd: `${remoteHost} · ${remoteCwd}`, worktree: false },
                        "selecting an SSH project resets to Chat, then discloses its saved destination without a local override or worktree",
                    );
                    assert.equal(
                        app.sessions().length,
                        beforeCollapse + 1,
                        "switching projects never starts work",
                    );
                    await leaveCreation(page, scope);

                    await groupClick(page, scope, name, ".project-disclosure");
                    await disclosure(page, scope, name, false);
                    await present(page, `${scope} .session-row[data-id="${standaloneChat.id}"]`);
                    await disclosure(peer, scope, name, true);
                    await groupClick(page, scope, name, ".project-disclosure");
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
                    await home(page, scope);
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
                    await startOptions(page, "One-time Chat");
                    assert.equal(
                        await value(
                            page,
                            `document.querySelector('${flow} select[aria-label="Thread type"]') === null`,
                        ),
                        true,
                        "the owner-only one-time flow is explicitly Chat, not a hidden standalone starter picker",
                    );
                    const chat = await start(page, app, "Chat");

                    assert.equal(chat.threadType, "chat");
                    assert.equal(chat.projectId, undefined);
                    await home(page, scope);
                    assert.equal(await rowTag(page, scope, chat.id, "Chat"), true);
                    await present(peer, `${scope} .session-row[data-id="${chat.id}"]`);

                    for (const type of ["Pull", "Researcher"] as const) {
                        const threadType = type.toLowerCase();

                        // One-time Home creation is Chat-only. Existing standalone profiles must
                        // still render their typed chips; their creation is covered by app tests.
                        const standalone = await newSession(app, cwd, threadType);
                        const savedStandalone = app
                            .sessions()
                            .find((session) => session.id === standalone)!;

                        assert.equal(savedStandalone.threadType, threadType);
                        assert.equal(savedStandalone.projectId, undefined);
                        await present(page, `${scope} .session-row[data-id="${standalone}"]`);
                        assert.equal(await rowTag(page, scope, standalone, type), true);
                        await present(peer, `${scope} .session-row[data-id="${standalone}"]`);
                        await click(page, `${scope} .new-button[aria-label="New session"]`);
                        await chooseProject(page, name);
                        await page.evaluate(`const field = document.querySelector('${flow} select[aria-label="Thread type"]');
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
                        await home(page, scope);
                        await click(page, `${scope} .new-button[aria-label="New session"]`);
                        await chooseProject(page, name);
                        assert.deepEqual(
                            await value(
                                page,
                                `[...document.querySelectorAll('${flow} select[aria-label="Thread type"] option')].map(option => option.value)`,
                            ),
                            ["worker"],
                            "project starters offer only available non-Chat profiles",
                        );
                        await startOptions(page, "One-time Chat");
                        assert.equal(
                            await value(
                                page,
                                `[...document.querySelectorAll('${panel} button')].some(button => button.textContent.trim() === 'Start Chat' && !button.disabled)`,
                            ),
                            true,
                            "the advertised Chat starter remains available outside projects",
                        );
                        await leaveCreation(page, scope);
                    } finally {
                        app.hello = hello;
                    }

                    await home(page, scope);
                    await chatRowGeometry(page, scope);
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
        const mobile = ".home-list > .sessions";

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
            await showSessions(page, mobile);
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
            await showSessions(page, mobile);
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
            await showSessions(page, mobile);
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
