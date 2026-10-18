// Authoring gate: real browser move gestures/forms must deliver committed placement to peers.
// Risks: drag-only targets shift rows, native drag cancelled by re-render, partial failures lose selection,
// cancelled/touch moves mutate the wrong rows, cramped picker actions and reader mutation controls.
// projects.test.ts owns authorization/storage; projects-ui.test.ts owns creation/disclosure.
// These tests own move interaction/transport, with no production seams or provider calls.
import { type App, cleanUp, openApp, owner, root, scriptedModel, until, work } from "./helpers.ts";
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
import { createHandler } from "../src/server/http.ts";

const sidebar = ".sidebar .sessions";
const home = ".home-list .sessions";
const dialog = '[role="dialog"]';
const projectField = `${dialog} select[aria-label="Project"]`;
const browserOptions = {
    skip: findBrowser() === undefined ? "no Chromium installed" : false,
    timeout: 90_000,
};

after(cleanUp);

async function value<T>(page: BrowserPage, expression: string): Promise<T> {
    return JSON.parse(await page.evaluate(`return JSON.stringify(${expression})`)) as T;
}

async function present(page: BrowserPage, selector: string, expected = true) {
    await until(
        () =>
            value<boolean>(
                page,
                `[...document.querySelectorAll(${JSON.stringify(selector)})]
            .some(element => element.getBoundingClientRect().width > 0
                && element.getBoundingClientRect().height > 0) === ${expected}`,
            ),
        `${expected ? "show" : "hide"} ${selector}`,
    );
}

async function click(page: BrowserPage, selector: string) {
    await present(page, selector);
    await page.evaluate(`document.querySelector(${JSON.stringify(selector)}).click()`);
}

async function button(page: BrowserPage, scope: string, text: string) {
    const expression = `[...document.querySelectorAll(${JSON.stringify(`${scope} button`)})]
        .find(element => element.textContent.trim() === ${JSON.stringify(text)}
            && element.getBoundingClientRect().width > 0)`;

    await until(() => value<boolean>(page, `Boolean(${expression})`), `${scope}: ${text}`);
    await page.evaluate(`(${expression}).click()`);
}

const row = (scope: string, id: ConversationId) => `${scope} .session-row[data-id="${id}"]`;
const project = (scope: string, id: string) => `${scope} .project-section[data-project-id="${id}"]`;
const head = (section: string) => `${section} > .project-group-head .group-head`;
const overlay = (scope: string, id: ConversationId) => `${row(scope, id)} .session-hold`;

async function openOptions(page: BrowserPage, scope: string, id: ConversationId, title: string) {
    const point = await beginTouch(page, scope, id);

    await present(page, overlay(scope, id));
    await finger(page, "touchmove", { x: point.x + 16, y: point.y });
    await present(page, `[role="dialog"][aria-label=${JSON.stringify(title)}]`);
    await finger(page, "touchend");
}

async function openMove(page: BrowserPage, scope: string, id: ConversationId, title: string) {
    await openOptions(page, scope, id, title);
    await button(page, dialog, "Move to project…");
    await present(page, '[role="dialog"][aria-label="Move session"]');
}

async function pause(page: BrowserPage, ms: number) {
    await page.evaluate(`await new Promise(resolve => setTimeout(resolve, ${ms}))`);
}

async function beginTouch(page: BrowserPage, scope: string, id: ConversationId) {
    await present(page, `${row(scope, id)} .session`);
    await page.evaluate(`
        await Promise.all(document.getAnimations()
            .filter(animation => animation.effect?.getComputedTiming().endTime !== Infinity)
            .map(animation => animation.finished.catch(() => {})));
        document.querySelector(${JSON.stringify(`${row(scope, id)} .session`)})
            .scrollIntoView({ block: 'nearest', behavior: 'instant' });
        await new Promise(resolve => {
            let timer;
            const done = () => {
                document.removeEventListener('scroll', quiet, true);
                resolve();
            };
            const quiet = () => {
                clearTimeout(timer);
                timer = setTimeout(done, 120);
            };

            document.addEventListener('scroll', quiet, true);
            quiet();
        });
    `);

    return value<{ x: number; y: number }>(
        page,
        `(() => {
            const target = document.querySelector(${JSON.stringify(`${row(scope, id)} .session`)});

            const rect = target.closest('.session-row').getBoundingClientRect();
            const point = { x: rect.left + rect.width / 2, y: rect.top + rect.height / 2 };

            window.sessionFinger = { target, point };
            const finger = new Touch({ identifier: 41, target, clientX: point.x, clientY: point.y });
            const event = new TouchEvent('touchstart', {
                bubbles: true, cancelable: true, touches: [finger], changedTouches: [finger],
            });

            target.dispatchEvent(event);

            if (event.defaultPrevented) {
                throw new Error('Ordinary touch down must remain available to taps and scrolling');
            }

            return point;
        })()`,
    );
}

async function finger(
    page: BrowserPage,
    type: "touchmove" | "touchend" | "touchcancel" | "touchstart",
    point?: { x: number; y: number },
    second = false,
) {
    return value<boolean>(
        page,
        `(() => {
            const { target } = window.sessionFinger;
            const point = ${JSON.stringify(point)} ?? window.sessionFinger.point;

            window.sessionFinger.point = point;
            const touch = new Touch({ identifier: 41, target, clientX: point.x, clientY: point.y });
            const thumb = new Touch({ identifier: 42, target, clientX: point.x + 20, clientY: point.y });
            const touches = ${JSON.stringify(type)} === 'touchend' || ${JSON.stringify(type)} === 'touchcancel'
                ? [] : ${second} ? [touch, thumb] : [touch];
            const event = new TouchEvent(${JSON.stringify(type)}, {
                bubbles: true, cancelable: true, touches, changedTouches: ${second} ? [thumb] : [touch],
            });

            target.dispatchEvent(event);

            return event.defaultPrevented;
        })()`,
    );
}

async function observeShortcutEscapes(page: BrowserPage) {
    await page.evaluate(`
        window.shortcutEscapes = 0;
        addEventListener('keydown', event => {
            if (event.key === 'Escape' && !event.defaultPrevented) {
                window.shortcutEscapes++;
            }
        });
    `);
}

async function touchDrag(page: BrowserPage, scope: string, id: ConversationId) {
    const point = await beginTouch(page, scope, id);

    await present(page, overlay(scope, id));
    assert.equal(await finger(page, "touchmove", { x: point.x - 16, y: point.y }), true);
    await present(page, `${scope} .session-drop-unassigned`);

    return point;
}

async function selectRows(page: BrowserPage, scope: string, ids: ConversationId[]) {
    for (const id of ids) {
        await present(page, `${row(scope, id)} .session`);
        // Use keyboard-style Ctrl+click selection, without opening/navigating the conversation.
        await page.evaluate(`document.querySelector(${JSON.stringify(`${row(scope, id)} .session`)})
            .dispatchEvent(new MouseEvent('click', { bubbles: true, ctrlKey: true }))`);
        await present(page, `${row(scope, id)}.selected`);
        await present(page, `${row(scope, id)} .session-side [aria-label="Selected"]`);
    }
}

function metadata(app: App, id: ConversationId) {
    const item = app.sessionMeta(id);

    assert.ok(item);

    return {
        cwd: app.cwdOf(id),
        threadType: item.threadType,
        archived: item.archived === true,
        projectId: item.projectId ?? null,
    };
}

async function moved(
    fixture: Awaited<ReturnType<typeof setup>>,
    pages: BrowserPage[],
    scope: string,
    id: ConversationId,
    before: ReturnType<typeof metadata>,
    projectId: string | null,
) {
    await until(() => {
        const item = fixture.app.sessionMeta(id);

        return (item?.projectId ?? null) === projectId;
    }, `committed placement for ${id}`);
    assert.deepEqual(metadata(fixture.app, id), { ...before, projectId });

    for (const page of pages) {
        await present(page, row(scope, id));
        // The untouched peer can relocate its row only through committed catalogue event delivery.
        await until(
            () =>
                value<boolean>(
                    page,
                    `(() => {
            const row = document.querySelector(${JSON.stringify(row(scope, id))});

            return (row.closest('.project-section')?.dataset.projectId ?? null)
                === ${JSON.stringify(projectId)};
        })()`,
                ),
            `peer/UI placement for ${id}`,
        );
    }
}

async function shot(page: BrowserPage, name: string, settle = true) {
    const directory = process.env.SESSION_MOVES_SCREENSHOT_DIR;

    if (directory === undefined) {
        return;
    }

    mkdirSync(directory, { recursive: true });

    if (settle) {
        await page.evaluate(`await Promise.all(document.getAnimations()
            .filter(animation => animation.effect?.getComputedTiming().endTime !== Infinity)
            .map(animation => animation.finished.catch(() => {})))`);
    }

    const captured = await page.screenshot();

    writeFileSync(join(directory, `${name}.jpg`), Buffer.from(captured.data, "base64"));
}

async function nativeDrop(page: BrowserPage, source: string, target: string) {
    await page.evaluate(`
        await document.fonts.ready;
        await Promise.all(document.getAnimations()
            .filter(animation => animation.effect?.getComputedTiming().endTime !== Infinity)
            .map(animation => animation.finished.catch(() => {})));
    `);
    const start = await page.locate({ selector: source });
    const positions = `([...document.querySelectorAll('${sidebar} .project-group-head, ${sidebar} .session-row')]
        .map(element => ({
            key: element.classList.contains('session-row')
                ? element.dataset.id
                : element.querySelector('.group-head').title,
            top: element.getBoundingClientRect().top,
        })))`;
    const before = await value<{ key: string; top: number }[]>(page, positions);

    await page.evaluate(`
        window.nativeMoveEvents = [];

        for (const type of ['dragstart', 'drop']) {
            document.addEventListener(type, event => window.nativeMoveEvents.push({
                type: event.type, trusted: event.isTrusted,
            }), { capture: true, once: true });
        }
    `);
    await page.input([
        { type: "mouse", action: "move", x: start.x, y: start.y },
        { type: "mouse", action: "down", x: start.x, y: start.y },
        { type: "mouse", action: "move", x: start.x + 12, y: start.y, pressed: true },
        { type: "mouse", action: "move", x: start.x + 20, y: start.y, pressed: true },
    ]);

    try {
        await present(page, `${sidebar} .session-drop-unassigned`);
        const during = await value<{ key: string; top: number }[]>(page, positions);

        assert.deepEqual(
            during.map((item) => item.key),
            before.map((item) => item.key),
        );

        for (const [index, item] of before.entries()) {
            assert.ok(
                Math.abs(during[index]!.top - item.top) < 1,
                `${item.key}: starting drag does not move existing project headers or rows`,
            );
        }

        assert.equal(
            await value(
                page,
                `(() => {
                const list = document.querySelector('${sidebar} .session-items');
                const tools = document.querySelector('${sidebar} .session-drag-tools');
                const target = tools.querySelector('.session-drop-unassigned');
                const normal = [...list.querySelectorAll('.project-group-head, .session-row')];

                return list.contains(tools) && tools.contains(target)
                    && normal.every(element =>
                        Boolean(element.compareDocumentPosition(tools) & Node.DOCUMENT_POSITION_FOLLOWING)
                        && tools.getBoundingClientRect().top >= element.getBoundingClientRect().bottom - 1);
            })()`,
            ),
            true,
            "the status and No project target follow existing rows inside the scrollable list",
        );
        const destination = await page.locate({ selector: target });

        await page.input([
            { type: "mouse", action: "move", x: destination.x, y: destination.y, pressed: true },
            {
                type: "mouse",
                action: "move",
                x: destination.x + 1,
                y: destination.y,
                pressed: true,
            },
        ]);
        await shot(page, "desktop-native-drop");
        await page.input([{ type: "mouse", action: "up", x: destination.x + 1, y: destination.y }]);
        assert.deepEqual(
            await value(page, "window.nativeMoveEvents"),
            [
                { type: "dragstart", trusted: true },
                { type: "drop", trusted: true },
            ],
            "Chromium delivered both events without synthetic DragEvent dispatch",
        );
    } finally {
        await page.input([{ type: "mouse", action: "up", x: start.x, y: start.y }]);
        await page.evaluate("delete window.nativeMoveEvents");
    }
}

async function cancelAfterTabHover(page: BrowserPage, source: string) {
    await page.evaluate(`await Promise.all(document.getAnimations()
        .filter(animation => animation.effect?.getComputedTiming().endTime !== Infinity)
        .map(animation => animation.finished.catch(() => {})))`);
    const start = await page.locate({ selector: source });

    await page.evaluate(`
        const source = document.querySelector(${JSON.stringify(source)});

        window.cancelledDrag = { source, ended: false };
        source.addEventListener('dragend', event => {
            window.cancelledDrag.ended = event.isTrusted;
        }, { once: true });
    `);
    await page.input([
        { type: "mouse", action: "move", x: start.x, y: start.y },
        { type: "mouse", action: "down", x: start.x, y: start.y },
        { type: "mouse", action: "move", x: start.x + 12, y: start.y, pressed: true },
        { type: "mouse", action: "move", x: start.x + 20, y: start.y, pressed: true },
    ]);

    try {
        await present(page, `${sidebar} .session-drop-unassigned`);
        const tab = await value<{ x: number; y: number }>(
            page,
            `(() => {
            const button = [...document.querySelectorAll('${sidebar} .session-tabs button')]
                .find(button => button.textContent.trim() === 'Projects');
            const rect = button.getBoundingClientRect();

            return { x: rect.left + rect.width / 2, y: rect.top + rect.height / 2 };
        })()`,
        );

        await page.input([
            { type: "mouse", action: "move", ...tab, pressed: true },
            { type: "mouse", action: "move", x: tab.x + 1, y: tab.y, pressed: true },
        ]);
        await until(
            () =>
                value<boolean>(
                    page,
                    `document.querySelector('${sidebar} .session-tabs [aria-selected=true]')?.textContent.trim() === 'Projects'`,
                ),
            "native drag hover switches tabs",
        );
        assert.equal(await value(page, "window.cancelledDrag.source.isConnected"), false);
        await page.input([
            { type: "mouse", action: "move", x: 800, y: 400, pressed: true },
            { type: "mouse", action: "up", x: 800, y: 400 },
        ]);
        await until(
            () => value<boolean>(page, "window.cancelledDrag.ended"),
            "native dragend reaches the detached source",
        );
        await present(page, `${sidebar} .session-drop-unassigned`, false);
    } finally {
        await page.input([{ type: "mouse", action: "up", x: 800, y: 400 }]);
        await page.evaluate("delete window.cancelledDrag");
    }
}

async function drag(page: BrowserPage, source: string, target: string, expand = false) {
    await present(page, source);
    assert.equal(
        await value<boolean>(
            page,
            `await (async () => {
        const source = document.querySelector(${JSON.stringify(source)});
        const transfer = new DataTransfer();
        const send = (element, type) => element.dispatchEvent(new DragEvent(type, {
            bubbles: true, cancelable: true, dataTransfer: transfer,
        }));

        send(source, 'dragstart');
        await new Promise(requestAnimationFrame);
        const target = document.querySelector(${JSON.stringify(target)});

        if (!target || !target.getBoundingClientRect().height) {
            throw new Error('Drop target not visible during drag');
        }

        send(target, 'dragover');

        if (${expand}) {
            await new Promise(resolve => setTimeout(resolve, 800));

            if (target.getAttribute('aria-expanded') !== 'true') {
                throw new Error('Hover did not expand the collapsed project');
            }
        }

        send(target, 'drop');
        send(source, 'dragend');

        return source.draggable;
    })()`,
        ),
        true,
    );
}

async function setup(name: string, viewport: "mobile" | "desktop") {
    const folder = (suffix: string) => {
        const path = join(work, `${name}-${suffix}`);

        mkdirSync(path);

        return realpathSync(path);
    };

    const cwd = folder("actual");
    const model = scriptedModel();
    const app = await openApp(model, join(root, `${name}-data`));
    const user = owner(app);
    const alpha = await app.projects.create(user, {
        name: "Alpha",
        cwd: folder("alpha-default"),
        requestId: crypto.randomUUID(),
    });
    const beta = await app.projects.create(user, {
        name: "Beta",
        cwd: folder("beta-default"),
        requestId: crypto.randomUUID(),
    });
    const worker = await app.commands.createSession(user, {
        title: "Worker to move",
        projectId: alpha.id,
        cwd,
    });
    const chat = await app.commands.createSession(user, {
        title: "Chat to move",
        projectId: alpha.id,
        threadType: "chat",
        cwd,
    });

    await app.commands.createSession(user, { projectId: beta.id });
    const participant = app.config.addUser("Move participant", "guest");
    const viewer = app.config.addUser("Move reader", "viewer");
    const denied = new Set<string>();
    const expectedDenials = new Set<string>();
    const requests: string[] = [];
    const handler = createHandler({
        app,
        listen: { host: "127.0.0.1", port: 0 },
        restart: () => {},
    });
    const server = createServer((request, response) => {
        if (request.method === "POST" && /^\/api\/sessions\/\d+$/.test(request.url ?? "")) {
            requests.push(request.url!);

            // Only a transport failure is injected: UI selection, success and metadata use real owners.
            if (denied.has(request.url!)) {
                expectedDenials.add(request.url!);
                response.writeHead(403, { "content-type": "application/json" });
                response.end(JSON.stringify({ error: "Blocked move" }));

                return;
            }
        }

        void handler(request, response);
    });
    const browsers = new Browsers({
        dataDir: join(root, `${name}-browser`),
        load: async () => undefined,
        save: () => {},
    });

    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const address = server.address();

    assert.ok(address !== null && typeof address === "object");
    const scope = viewport === "desktop" ? sidebar : home;
    const pages: BrowserPage[] = [];

    const connect = async (id: number, token: string) => {
        const page = await browsers.open(id);

        pages.push(page);
        await page.setViewport(VIEWPORTS[viewport]);
        await page.navigate(
            `http://127.0.0.1:${address.port}/login?token=${encodeURIComponent(token)}`,
        );
        await present(page, project(scope, beta.id));

        return page;
    };

    const close = async () => {
        try {
            assert.equal(model.state.callCount, 0, "organization never submits model work");
            assert.deepEqual(
                pages
                    .flatMap((page) => page.logs())
                    .filter(
                        (entry) =>
                            entry.level === "error" &&
                            ![...expectedDenials].some(
                                (path) =>
                                    entry.source?.endsWith(path) &&
                                    entry.text.includes("403 (Forbidden)"),
                            ),
                    ),
                [],
                "no browser errors",
            );
        } finally {
            await browsers.closeAll({ final: true });
            server.closeAllConnections();
            await new Promise<void>((resolve) => server.close(() => resolve()));
            await app.close();
        }
    };

    return {
        app,
        participant,
        viewer,
        denied,
        requests,
        connect,
        close,
        alpha: alpha.id,
        beta: beta.id,
        worker: worker.id,
        chat: chat.id,
    };
}

// Regression: iPad touch capability must not force context actions into a bottom sheet.
// These cases own menu placement/input routing; existing phone hold tests own sheet actions.
test(
    "tablet holds and hybrid-device right clicks open anchored, keyboard-accessible Options",
    browserOptions,
    async () => {
        const fixture = await setup("tablet-options", "desktop");
        const menu = '.sidebar-options-menu[role="menu"]';

        try {
            const page = await fixture.connect(1, fixture.participant.token);
            const path = await value<string>(page, "location.pathname");

            const dismiss = async () => {
                await page.press("Escape");
                await present(page, menu, false);
                await present(page, ".sidebar-options-sheet", false);
            };

            const assertAnchor = async (point: { x: number; y: number }) => {
                await present(page, menu);
                await page.evaluate(`await Promise.all(document.getAnimations()
                    .filter(animation => animation.effect?.getComputedTiming().endTime !== Infinity)
                    .map(animation => animation.finished.catch(() => {})))`);
                const bounds = await value<{
                    left: number;
                    top: number;
                    right: number;
                    bottom: number;
                }>(
                    page,
                    `(() => {
                        const rect = document.querySelector('${menu}').getBoundingClientRect();
                        return { left: rect.left, top: rect.top, right: rect.right, bottom: rect.bottom };
                    })()`,
                );

                assert.ok(
                    Math.abs(bounds.left - point.x) < 2,
                    "menu opens at the contact, not screen center",
                );
                assert.ok(
                    bounds.top <= point.y + 2,
                    "menu stays beside the contact or clamps above it",
                );
                assert.ok(
                    bounds.top >= 8 &&
                        bounds.bottom <= (await value<number>(page, "innerHeight")) - 7,
                );
                assert.ok(bounds.right <= (await value<number>(page, "innerWidth")) - 7);
                assert.equal(
                    await value(page, "location.pathname"),
                    path,
                    "Options never opens the thread",
                );
            };

            for (const viewport of [
                { width: 820, height: 1180 },
                { width: 1180, height: 820 },
            ]) {
                await page.setViewport({ ...VIEWPORTS.mobile, ...viewport });
                assert.equal(await value(page, 'matchMedia("(pointer: coarse)").matches'), true);
                const point = await beginTouch(page, sidebar, fixture.worker);

                await present(page, overlay(sidebar, fixture.worker));
                await finger(page, "touchmove", { x: point.x + 16, y: point.y });
                await assertAnchor({ x: point.x + 16, y: point.y });
                await finger(page, "touchend");
                await dismiss();

                // Project holds use a separate recognizer and must preserve their contact too.
                const projectHead = head(project(sidebar, fixture.alpha));
                const projectPoint = await value<{ x: number; y: number }>(
                    page,
                    `(() => {
                    const target = document.querySelector(${JSON.stringify(projectHead)});
                    const rect = target.getBoundingClientRect();
                    const point = { x: rect.left + 80, y: rect.top + rect.height / 2 };
                    const touch = new Touch({ identifier: 41, target, clientX: point.x, clientY: point.y });
                    window.sessionFinger = { target, point };
                    target.dispatchEvent(new TouchEvent('touchstart', {
                        bubbles: true, cancelable: true, touches: [touch], changedTouches: [touch],
                    }));
                    return point;
                })()`,
                );

                await assertAnchor(projectPoint);
                await finger(page, "touchend");
                await dismiss();
            }

            // Mouse/keyboard context requests stay menus even in narrow Split View/phone layouts,
            // and immediately following a touch on the same hybrid input device.
            await page.setViewport(VIEWPORTS.mobile);
            await beginTouch(page, home, fixture.worker);
            await finger(page, "touchend");
            const source = `${row(home, fixture.worker)} .session`;
            const mousePoint = { x: 40, y: 120 };

            await page.evaluate(`document.querySelector(${JSON.stringify(source)}).dispatchEvent(
                new MouseEvent('contextmenu', { bubbles: true, cancelable: true, button: 2,
                    clientX: ${mousePoint.x}, clientY: ${mousePoint.y} }))`);
            await assertAnchor(mousePoint);
            await page.press("End");
            assert.equal(
                await value(
                    page,
                    `document.activeElement === document.querySelector('${menu} button:last-child')`,
                ),
                true,
            );
            await page.press("Home");
            assert.equal(
                await value(
                    page,
                    `document.activeElement === document.querySelector('${menu} button')`,
                ),
                true,
            );
            await button(page, menu, "Pin to the top");
            await present(page, menu, false);

            // Safari may expose click as MouseEvent even when pointerdown has a pointerType.
            // Touch -> mouse -> keyboard must resolve the source button, not a device-wide mode.
            const sourceOptions = `${row(home, fixture.worker)} .session-options`;

            const pointerClick = async (pointer: string, detail = 1) => {
                await page.evaluate(`
                    const target = document.querySelector(${JSON.stringify(sourceOptions)});
                    target.dispatchEvent(new PointerEvent('pointerdown', {
                        bubbles: true, pointerType: ${JSON.stringify(pointer)}, button: 0,
                    }));
                    target.dispatchEvent(new MouseEvent('click', {
                        bubbles: true, cancelable: true, detail: ${detail},
                    }));
                `);
            };

            await pointerClick("touch");
            await present(page, ".sidebar-options-sheet");
            await dismiss();
            await pointerClick("mouse");
            await present(page, menu);
            await present(page, ".sidebar-options-sheet", false);
            await dismiss();
            await pointerClick("touch", 0);
            await present(page, menu);
            await dismiss();

            await page.evaluate(`document.querySelector(${JSON.stringify(source)}).dispatchEvent(
                new KeyboardEvent('keydown', { key: 'F10', shiftKey: true, bubbles: true, cancelable: true }))`);
            await present(page, menu);
            await until(
                () =>
                    value<boolean>(
                        page,
                        `document.querySelector('${menu}').contains(document.activeElement)`,
                    ),
                "keyboard context menu takes focus",
            );
            assert.equal(
                await value(
                    page,
                    `[...document.querySelectorAll('${menu} button')].some(button => button.textContent.trim() === 'Unpin')`,
                ),
                true,
                "menu action pins without navigating",
            );
            await dismiss();
        } finally {
            await fixture.close();
        }
    },
);

test(
    "native mouse drops update peers and cancellation survives a hover tab switch",
    browserOptions,
    async () => {
        const fixture = await setup("native-move", "desktop");

        try {
            const page = await fixture.connect(1, fixture.participant.token);
            const peer = await fixture.connect(2, fixture.app.config.ownerToken);
            const before = metadata(fixture.app, fixture.worker);

            await nativeDrop(
                page,
                `${row(sidebar, fixture.worker)} .session`,
                head(project(sidebar, fixture.beta)),
            );
            await moved(fixture, [page, peer], sidebar, fixture.worker, before, fixture.beta);
            const requests = fixture.requests.length;
            const placement = metadata(fixture.app, fixture.worker);

            await button(page, `${sidebar} .session-tabs:not(.private-tabs)`, "Recent");
            await cancelAfterTabHover(page, `${row(sidebar, fixture.worker)} .session`);
            assert.equal(fixture.requests.length, requests, "outside drop sends no move request");
            assert.deepEqual(metadata(fixture.app, fixture.worker), placement);
        } finally {
            await fixture.close();
        }
    },
);

test(
    "selected drops preserve successes and failed selection, retry, and support unassigned",
    browserOptions,
    async () => {
        const fixture = await setup("bulk-move", "desktop");

        try {
            const page = await fixture.connect(1, fixture.participant.token);
            const peer = await fixture.connect(2, fixture.app.config.ownerToken);
            const before = metadata(fixture.app, fixture.worker);
            const chatBefore = metadata(fixture.app, fixture.chat);
            const destination = head(project(sidebar, fixture.beta));

            await click(page, destination);
            await selectRows(page, sidebar, [fixture.worker, fixture.chat]);
            fixture.denied.add(`/api/sessions/${fixture.chat}`);
            await drag(page, `${row(sidebar, fixture.worker)} .session`, destination, true);
            await moved(fixture, [page, peer], sidebar, fixture.worker, before, fixture.beta);
            assert.deepEqual(metadata(fixture.app, fixture.chat), chatBefore);
            await present(page, `${row(sidebar, fixture.worker)}.selected`, false);
            await present(page, `${row(sidebar, fixture.chat)}.selected`);
            await until(
                () =>
                    value<boolean>(
                        page,
                        "document.body.textContent.includes('Moved 1 of 2 sessions.') && document.body.textContent.includes('Blocked move')",
                    ),
                "partial error names success and denial",
            );
            fixture.denied.clear();
            await drag(page, `${row(sidebar, fixture.chat)} .session`, destination);
            await moved(fixture, [page, peer], sidebar, fixture.chat, chatBefore, fixture.beta);
            await present(page, `${sidebar} .session-drop-unassigned`, false);
            await drag(
                page,
                `${row(sidebar, fixture.worker)} .session`,
                `${sidebar} .session-drop-unassigned`,
            );
            await moved(fixture, [page, peer], sidebar, fixture.worker, before, null);
            await present(page, `${sidebar} .session-drop-unassigned`, false);
            await shot(page, "desktop-bulk-moved");
        } finally {
            await fixture.close();
        }
    },
);

test(
    "mobile Move cancels without mutation, detaches archived threads and hides reader controls",
    browserOptions,
    async () => {
        const fixture = await setup("picker-move", "mobile");

        try {
            await fixture.app.commands.updateSession(fixture.worker, owner(fixture.app), {
                archived: true,
            });
            const page = await fixture.connect(1, fixture.participant.token);
            const peer = await fixture.connect(2, fixture.app.config.ownerToken);
            const before = metadata(fixture.app, fixture.worker);

            for (const connected of [page, peer]) {
                await button(connected, `${home} .session-tabs:not(.private-tabs)`, "Archived");
            }

            assert.equal(
                await value(
                    page,
                    `(() => {
                    const cog = document.querySelector('${row(home, fixture.worker)} .session-options');
                    const bounds = cog.getBoundingClientRect();

                    cog.focus();

                    return bounds.width === 0 && bounds.height === 0 && document.activeElement !== cog;
                })()`,
                ),
                true,
                "mobile row cogs are neither visible nor focusable; the hold chooser owns Options",
            );

            const open = async () => {
                await openMove(page, home, fixture.worker, "Worker to move");
            };

            const choose = async () => {
                await page.select({ selector: projectField }, fixture.beta);
                assert.equal(
                    await value(page, `document.querySelectorAll('${dialog} select').length`),
                    1,
                    "a project is the complete destination; no extra placement choice is required",
                );
            };

            const save = async () => {
                await button(page, dialog, "Move");
                await present(page, dialog, false);
            };

            const requests = fixture.requests.length;

            await open();
            await choose();
            const layout = await value<{
                labels: string[];
                buttons: { left: number; right: number; width: number }[];
                left: number;
                right: number;
            }>(
                page,
                `(() => {
                    const form = document.querySelector('${dialog} .session-move-form');
                    const actions = [...form.querySelectorAll('.session-move-actions button')];
                    const bounds = form.getBoundingClientRect();

                    return {
                        labels: actions.map(button => button.textContent.trim()),
                        buttons: actions.map(button => {
                            const rect = button.getBoundingClientRect();

                            return { left: rect.left, right: rect.right, width: rect.width };
                        }),
                        left: bounds.left,
                        right: bounds.right,
                    };
                })()`,
            );

            assert.deepEqual(
                layout.labels,
                ["Cancel", "Move"],
                "cancel precedes the submit action",
            );
            const [cancel, move] = layout.buttons;

            assert.ok(cancel && move);
            assert.ok(cancel.width > 0 && move.left >= cancel.right, "actions sit side by side");
            assert.ok(
                Math.abs(cancel.width - move.width) < 1,
                "actions have equal rendered widths",
            );
            assert.ok(
                Math.abs(cancel.left - layout.left) < 1 && Math.abs(move.right - layout.right) < 1,
                "the action buttons fill the mobile form width",
            );
            await shot(page, "mobile-move-picker");
            await button(page, dialog, "Cancel");
            await present(page, dialog, false);
            assert.equal(fixture.requests.length, requests, "cancel sends no placement request");
            assert.deepEqual(metadata(fixture.app, fixture.worker), before);
            await open();
            await choose();
            await save();
            await moved(fixture, [page, peer], home, fixture.worker, before, fixture.beta);
            await open();
            assert.equal(
                await value(page, `document.querySelector(${JSON.stringify(projectField)}).value`),
                fixture.beta,
                "the picker reopens at the thread's current project",
            );
            await page.select({ selector: projectField }, "");
            await save();
            await moved(fixture, [page, peer], home, fixture.worker, before, null);
            const reader = await fixture.connect(3, fixture.viewer.token);

            await button(reader, `${home} .session-tabs:not(.private-tabs)`, "Archived");
            await moved(fixture, [reader], home, fixture.worker, before, null);

            for (const connected of [page, peer, reader]) {
                assert.deepEqual(
                    await value(
                        connected,
                        `(() => {
                            const chip = document.querySelector(${JSON.stringify(`${row(home, fixture.worker)} .session-state .thread-type`)});

                            return { label: chip.getAttribute('aria-label'), title: chip.title };
                        })()`,
                    ),
                    { label: "Worker", title: "Worker" },
                    "moving and reader projection retain the accessible thread type",
                );
            }

            assert.equal(
                await value<boolean>(
                    reader,
                    `[...document.querySelectorAll('${home} .session')].every(element => !element.draggable)`,
                ),
                true,
            );
            await selectRows(reader, home, [fixture.worker]);
            assert.equal(
                await value<boolean>(
                    reader,
                    `[...document.querySelectorAll('${home} [aria-label="Selected sessions"] button')].some(button => button.textContent.trim().startsWith('Move'))`,
                ),
                false,
            );
            assert.equal(
                await value(page, "document.documentElement.scrollWidth <= innerWidth"),
                true,
            );
            await openOptions(reader, home, fixture.worker, "Worker to move");
            await present(reader, '[role="dialog"][aria-label="Worker to move"]');
            assert.equal(
                await value<boolean>(
                    reader,
                    `[...document.querySelectorAll('${dialog} button')].some(button => /^(Move|Rename|Archive|Restore)/.test(button.textContent.trim()))`,
                ),
                false,
                "readers retain Options without mutation commands",
            );
            await shot(reader, "mobile-reader");
        } finally {
            await fixture.close();
        }
    },
);

// Hold coverage owns deliberate intent and lifecycle cancellation, not CSS implementation details.
// Removing the fresh-slide gate, failing to clear any pending timer, or swallowing a later tap
// must fail at the rendered row/menu boundary; native mouse/picker tests cannot exercise these.
test(
    "mobile hold needs a fresh slide and cancels interrupted choices without acting",
    browserOptions,
    async () => {
        const fixture = await setup("hold-intent", "mobile");

        try {
            const page = await fixture.connect(1, fixture.participant.token);
            const before = metadata(fixture.app, fixture.worker);
            const requests = fixture.requests.length;
            const source = row(home, fixture.worker);
            const hold = overlay(home, fixture.worker);
            const path = await value<string>(page, "location.pathname");

            await observeShortcutEscapes(page);

            const assertCancelled = async (name: string) => {
                await present(page, hold, false);
                await pause(page, 850);
                await present(page, dialog, false);
                await present(page, `${home} .session-drop-unassigned`, false);
                assert.equal(fixture.requests.length, requests, name);
                assert.deepEqual(metadata(fixture.app, fixture.worker), before, name);
            };

            // Movement before reveal is not credit toward the required post-reveal slide.
            const point = await beginTouch(page, home, fixture.worker);

            assert.equal(
                await value<boolean>(
                    page,
                    `(() => {
                const target = window.sessionFinger.target;
                const context = new MouseEvent('contextmenu', { bubbles: true, cancelable: true });
                const native = new DragEvent('dragstart', { bubbles: true, cancelable: true, dataTransfer: new DataTransfer() });

                target.dispatchEvent(context);
                target.dispatchEvent(native);

                return context.defaultPrevented && native.defaultPrevented;
            })()`,
                ),
                true,
                "native long-press menus and emulated drags cannot steal the pending hold",
            );
            await present(page, dialog, false);
            assert.equal(await finger(page, "touchmove", { x: point.x + 5, y: point.y }), false);
            await present(page, hold);
            await shot(page, "mobile-hold-neutral");
            await finger(page, "touchmove", { x: point.x + 9, y: point.y });
            await pause(page, 900);
            await present(page, dialog, false);
            await present(page, `${home} .session-drop-unassigned`, false);
            assert.equal(
                await finger(page, "touchend"),
                true,
                "a consumed hold suppresses its release",
            );
            await page.evaluate(`document.querySelector(${JSON.stringify(`${source} .session`)})
            .dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true, detail: 1 }))`);
            assert.equal(
                await value(page, "location.pathname"),
                path,
                "compatibility click cannot open the thread",
            );

            const interrupts = [
                "release",
                "outside row",
                "second finger",
                "touchcancel",
                "blur",
                "Escape",
                "scroll",
            ];

            for (const interrupt of interrupts) {
                const start = await beginTouch(page, home, fixture.worker);

                await present(page, hold);
                await finger(page, "touchmove", { x: start.x + 16, y: start.y });

                if (interrupt === "release") {
                    await finger(page, "touchend");
                } else if (interrupt === "outside row") {
                    await finger(page, "touchmove", { x: start.x + 16, y: start.y + 100 });
                } else if (interrupt === "second finger") {
                    await finger(page, "touchstart", undefined, true);
                } else if (interrupt === "touchcancel") {
                    await finger(page, "touchcancel");
                } else if (interrupt === "blur") {
                    await page.evaluate("dispatchEvent(new Event('blur'))");
                } else if (interrupt === "Escape") {
                    await page.press("Escape");
                    assert.equal(
                        await value(page, "window.shortcutEscapes"),
                        0,
                        "hold Escape cannot reach the window's stop-Pi shortcut",
                    );
                } else {
                    await page.evaluate(
                        `document.querySelector('${home} .session-items').dispatchEvent(new Event('scroll'))`,
                    );
                }

                await assertCancelled(interrupt);
                await finger(page, "touchend");
            }

            await page.press("Escape");
            assert.equal(
                await value(page, "window.shortcutEscapes"),
                1,
                "ordinary Escape remains available when there is no hold",
            );

            const switching = await beginTouch(page, home, fixture.worker);

            await present(page, hold);
            await finger(page, "touchmove", { x: switching.x + 16, y: switching.y });
            await pause(page, 400);
            await finger(page, "touchmove", { x: switching.x - 16, y: switching.y });
            await present(page, `${hold}[data-choice="drag"][data-phase="expand"]`);
            await pause(page, 400);
            await present(page, dialog, false);
            await present(page, `${home} .session-drop-unassigned`, false);
            await finger(page, "touchend");
            await assertCancelled(
                "switching halves restarts the full dwell, never commits the old choice",
            );

            const scrolling = await beginTouch(page, home, fixture.worker);

            assert.equal(
                await finger(page, "touchmove", { x: scrolling.x, y: scrolling.y + 24 }),
                false,
                "scroll intent before reveal is never prevented",
            );
            await assertCancelled("scroll before hold");
            await finger(page, "touchend");

            // Options commits only after a fresh slide plus expansion/fill, never on finger release.
            const options = await beginTouch(page, home, fixture.worker);

            await present(page, hold);
            await finger(page, "touchmove", { x: options.x + 16, y: options.y });
            await pause(page, 250);
            await shot(page, "mobile-hold-expanding", false);
            await present(page, '[role="dialog"][aria-label="Worker to move"]');
            await present(page, hold, false);
            assert.equal(await value(page, "location.pathname"), path, "Options does not navigate");
            await finger(page, "touchend");
            await page.evaluate(`await Promise.all(document.getAnimations()
                .filter(animation => animation.effect?.getComputedTiming().endTime !== Infinity)
                .map(animation => animation.finished.catch(() => {})))`);
            await page.press("Escape");
            await present(page, dialog, false);
            assert.equal(fixture.requests.length, requests);
            await openOptions(page, home, fixture.worker, "Worker to move");
            await present(page, '[role="dialog"][aria-label="Worker to move"]');
            assert.equal(
                await value(page, "location.pathname"),
                path,
                "a fresh intentional Options hold is not swallowed by the old held contact",
            );
            await page.evaluate(`await Promise.all(document.getAnimations()
                .filter(animation => animation.effect?.getComputedTiming().endTime !== Infinity)
                .map(animation => animation.finished.catch(() => {})))`);
            await page.press("Escape");
            await present(page, dialog, false);

            // Options replaces the legacy held-row sheet: its browser-local read actions and
            // Select must still work, not just appear beside the newer Move/Rename commands.
            const menu = '[role="dialog"][aria-label="Worker to move"]';

            for (const [label, marked] of [
                ["Mark unread", true],
                ["Mark read", false],
            ] as const) {
                await openOptions(page, home, fixture.worker, "Worker to move");
                await present(page, menu);
                await button(page, menu, label);
                await present(page, dialog, false);
                await present(page, `${source}.marked-unread`, marked);
            }

            await openOptions(page, home, fixture.worker, "Worker to move");
            await present(page, menu);
            await button(page, menu, "Select");
            await present(page, dialog, false);
            await present(page, `${source}.selected`);
            await click(page, `${row(home, fixture.chat)} .session`);
            await present(page, `${row(home, fixture.chat)}.selected`);
            assert.equal(
                await value(page, "location.pathname"),
                path,
                "Select makes ordinary row taps select more threads without opening them",
            );
            assert.equal(fixture.requests.length, requests, "read marks and selection stay local");
            assert.deepEqual(metadata(fixture.app, fixture.worker), before);
            await page.press("Escape");
            await present(page, `${source}.selected`, false);
            await present(page, `${row(home, fixture.chat)}.selected`, false);

            // Ordinary touch taps remain usable after consumed holds and selection.
            await beginTouch(page, home, fixture.worker);
            assert.equal(await finger(page, "touchend"), false);
            await page.evaluate(`document.querySelector(${JSON.stringify(`${source} .session`)})
            .dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true, detail: 1 }))`);
            await until(
                () => value<boolean>(page, `location.pathname === '/s/${fixture.worker}'`),
                "ordinary tap opens the thread",
            );
        } finally {
            await fixture.close();
        }
    },
);

// Options retains the drawer for legacy Select, but a catalogue update can still detach its row.
// The original finger must never activate a menu command after that source disappears.
test(
    "drawer Options hold consumes the detached finger through lift and compatibility click",
    browserOptions,
    async () => {
        const fixture = await setup("hold-drawer", "mobile");

        try {
            const page = await fixture.connect(1, fixture.participant.token);
            const before = metadata(fixture.app, fixture.worker);
            const requests = fixture.requests.length;
            const drawer = ".drawer .sessions";

            await click(page, `${row(home, fixture.worker)} .session`);
            await until(
                () => value<boolean>(page, `location.pathname === '/s/${fixture.worker}'`),
                "open thread before drawer",
            );
            const shortcut = await value<string>(
                page,
                `/Mac|iPhone|iPad/.test(navigator.platform) ? 'Meta+b' : 'Control+b'`,
            );

            await page.press(shortcut);
            await present(page, `${row(drawer, fixture.worker)} .session`);
            const point = await beginTouch(page, drawer, fixture.worker);

            await present(page, overlay(drawer, fixture.worker));
            await finger(page, "touchmove", { x: point.x + 16, y: point.y });
            await present(page, '[role="dialog"][aria-label="Worker to move"]');
            // A real owner edit removes the held row from Projects while its Options stays open.
            // Do not require opening Options itself to unmount the drawer: Select needs that list.
            await fixture.app.commands.updateSession(fixture.worker, owner(fixture.app), {
                archived: true,
            });
            await until(
                () => value<boolean>(page, "!window.sessionFinger.target.isConnected"),
                "a committed catalogue update detaches the original held row",
            );
            const command = await page.locate({ label: "Restore thread" });

            assert.equal(
                await finger(page, "touchmove", command),
                true,
                "detached source move remains consumed",
            );
            assert.equal(
                await finger(page, "touchend", command),
                true,
                "detached source release remains consumed",
            );
            assert.equal(
                await value<boolean>(
                    page,
                    `(() => {
            const button = [...document.querySelectorAll('${dialog} button')]
                .find(button => button.textContent.trim() === 'Restore thread');
            const event = new MouseEvent('click', {
                bubbles: true, cancelable: true, detail: 1,
                clientX: ${command.x}, clientY: ${command.y},
            });

            button.dispatchEvent(event);

            return event.defaultPrevented;
        })()`,
                ),
                true,
                "compatibility click cannot restore from the new sheet",
            );
            assert.equal(fixture.requests.length, requests);
            assert.deepEqual(metadata(fixture.app, fixture.worker), { ...before, archived: true });
            assert.equal(await value(page, "location.pathname"), `/s/${fixture.worker}`);
            await page.press("Escape");
            await present(page, dialog, false);
            await fixture.app.commands.updateSession(fixture.worker, owner(fixture.app), {
                archived: false,
            });
            await present(page, `${row(drawer, fixture.worker)} .session`);
            assert.deepEqual(metadata(fixture.app, fixture.worker), before);
            await openOptions(page, drawer, fixture.worker, "Worker to move");
            await present(page, '[role="dialog"][aria-label="Worker to move"]');
        } finally {
            await fixture.close();
        }
    },
);

// Touch DnD owns hit testing and tracking across source detach. A stale last highlight or
// row-owned tracking fails through real committed metadata.
test(
    "mobile touch drag keeps its source across tab hover and recomputes release targets",
    browserOptions,
    async () => {
        const fixture = await setup("touch-placement", "mobile");

        try {
            const page = await fixture.connect(1, fixture.participant.token);
            const peer = await fixture.connect(2, fixture.app.config.ownerToken);
            const before = metadata(fixture.app, fixture.worker);
            const destination = head(project(home, fixture.beta));

            await click(page, destination);
            await button(page, `${home} .session-tabs:not(.private-tabs)`, "Recent");
            await touchDrag(page, home, fixture.worker);
            const tab = await page.locate({
                selector: `${home} [data-session-projects-tab="true"]`,
            });

            await finger(page, "touchmove", tab);
            await until(
                () =>
                    value<boolean>(
                        page,
                        `document.querySelector('${home} .session-tabs [aria-selected=true]')?.textContent.trim() === 'Projects'`,
                    ),
                "touch dwell switches to Projects",
            );
            assert.equal(
                await value(page, "window.sessionFinger.target.isConnected"),
                false,
                "Projects hover genuinely detaches the original touch target",
            );
            const target = await page.locate({ selector: destination });

            await finger(page, "touchmove", target);
            await until(
                () =>
                    value<boolean>(
                        page,
                        `document.querySelector(${JSON.stringify(destination)}).getAttribute('aria-expanded') === 'true'`,
                    ),
                "touch dwell expands the closed project",
            );
            const requests = fixture.requests.length;

            await finger(page, "touchend", { x: 1, y: 1 });
            await present(page, `${home} .session-drop-unassigned`, false);
            assert.equal(
                fixture.requests.length,
                requests,
                "outside release cannot use the stale highlighted project",
            );
            assert.deepEqual(metadata(fixture.app, fixture.worker), before);
            // No artificial pause: this genuine mouse press must clear the touch owner's click
            // suppression while its compatibility-click window is still live.
            await page.click({ selector: `${row(home, fixture.worker)} .session` });
            await until(
                () => value<boolean>(page, `location.pathname === '/s/${fixture.worker}'`),
                "fresh native click after touch cancellation opens the thread",
            );
            await page.evaluate(`await Promise.all(document.getAnimations()
                .filter(animation => animation.effect?.getComputedTiming().endTime !== Infinity)
                .map(animation => animation.finished.catch(() => {})))`);
            await page.click({ selector: ".topbar-back" });
            await present(page, `${row(home, fixture.worker)} .session`);

            await touchDrag(page, home, fixture.worker);
            const release = await page.locate({ selector: destination });

            // No move at this position first: release itself must resolve the nearest destination.
            await finger(page, "touchend", release);
            await moved(fixture, [page, peer], home, fixture.worker, before, fixture.beta);
            await present(page, `${home} .session-drop-unassigned`, false);

            await touchDrag(page, home, fixture.worker);
            const unassigned = await page.locate({ selector: `${home} .session-drop-unassigned` });

            await finger(page, "touchend", unassigned);
            await moved(fixture, [page, peer], home, fixture.worker, before, null);
        } finally {
            await fixture.close();
        }
    },
);

// Access loss has a distinct owner-level lifecycle risk after the source row disappears;
// it must cancel without transport, while readers can still use the existing Options menu.
// Stationary edge autoscroll must reach the bottom drop target and stop on cancellation.
test(
    "touch drag reaches the bottom target, cancels on interruptions and access loss, and keeps reader Options",
    browserOptions,
    async () => {
        const fixture = await setup("touch-lifecycle", "mobile");

        try {
            for (let index = 0; index < 20; index++) {
                await fixture.app.commands.createSession(owner(fixture.app), {
                    title: `Scroll filler ${index}`,
                    projectId: fixture.alpha,
                });
            }

            const page = await fixture.connect(1, fixture.participant.token);
            const peer = await fixture.connect(2, fixture.app.config.ownerToken);
            const before = metadata(fixture.app, fixture.worker);
            const requests = fixture.requests.length;

            await touchDrag(page, home, fixture.worker);
            const edge = await value<{ x: number; y: number; top: number }>(
                page,
                `(() => {
                const list = document.querySelector('${home} .session-items');
                const rect = list.getBoundingClientRect();

                list.scrollTop = 0;

                return { x: rect.left + rect.width / 2, y: rect.bottom - 5, top: list.scrollTop };
            })()`,
            );

            await finger(page, "touchmove", edge);
            await until(
                () =>
                    value<boolean>(
                        page,
                        `document.querySelector('${home} .session-items').scrollTop > ${edge.top} + 10`,
                    ),
                "stationary touch at the list edge autoscrolls the actual scroll container",
            );
            await finger(page, "touchcancel");
            await present(page, `${home} .session-drop-unassigned`, false);
            assert.equal(
                fixture.requests.length,
                requests,
                "autoscroll cancellation sends no placement request",
            );

            await observeShortcutEscapes(page);

            for (const interrupt of ["second finger", "touchcancel", "blur", "Escape"]) {
                await touchDrag(page, home, fixture.worker);

                if (interrupt === "second finger") {
                    await finger(page, "touchstart", undefined, true);
                } else if (interrupt === "touchcancel") {
                    await finger(page, "touchcancel");
                } else if (interrupt === "Escape") {
                    await page.press("Escape");
                    assert.equal(
                        await value(page, "window.shortcutEscapes"),
                        0,
                        "drag Escape cannot reach the window's stop-Pi shortcut",
                    );
                } else {
                    await page.evaluate("dispatchEvent(new Event('blur'))");
                }

                await present(page, `${home} .session-drop-unassigned`, false);
                const target = await page.locate({ selector: head(project(home, fixture.beta)) });

                await finger(page, "touchend", target);
                assert.equal(fixture.requests.length, requests, interrupt);
                assert.deepEqual(metadata(fixture.app, fixture.worker), before, interrupt);
            }

            // The relocated target must be usable on an overflowing list, not just have dimensions
            // offscreen. Keep the contact at the edge until the real hit test reaches No project.
            await touchDrag(page, home, fixture.worker);
            await page.evaluate(`document.querySelector('${home} .session-items').scrollTop = 0`);
            assert.equal(
                await value(
                    page,
                    `Boolean(document.elementFromPoint(${edge.x}, ${edge.y})?.closest('.session-drop-unassigned'))`,
                ),
                false,
                "No project starts outside the touch hit area on the long list",
            );
            await finger(page, "touchmove", edge);
            await until(
                () =>
                    value<boolean>(
                        page,
                        `Boolean(document.elementFromPoint(${edge.x}, ${edge.y})?.closest('.session-drop-unassigned'))`,
                    ),
                "stationary edge autoscroll makes No project hit-testable",
            );
            await finger(page, "touchend", edge);
            await moved(fixture, [page, peer], home, fixture.worker, before, null);
            await present(page, `${home} .session-drop-unassigned`, false);
            const afterMove = metadata(fixture.app, fixture.worker);
            const afterMoveRequests = fixture.requests.length;

            await touchDrag(page, home, fixture.worker);
            fixture.app.setAccess(owner(fixture.app), fixture.participant.user.id, {
                role: "viewer",
            });
            await present(page, `${home} .session-drop-unassigned`, false);
            const target = await page.locate({ selector: head(project(home, fixture.beta)) });

            await finger(page, "touchend", target);
            assert.equal(
                fixture.requests.length,
                afterMoveRequests,
                "revoked steering cancels without a move request",
            );
            assert.deepEqual(metadata(fixture.app, fixture.worker), afterMove);
            const options = await beginTouch(page, home, fixture.worker);

            await present(page, overlay(home, fixture.worker));
            await finger(page, "touchmove", { x: options.x - 16, y: options.y });
            await pause(page, 850);
            await present(page, `${overlay(home, fixture.worker)}[data-phase="choose"]`);
            await present(page, `${home} .session-drop-unassigned`, false);
            await present(page, dialog, false);
            await finger(page, "touchmove", { x: options.x + 16, y: options.y });
            await present(page, '[role="dialog"][aria-label="Worker to move"]');
            await finger(page, "touchend");
            assert.equal(
                await value<boolean>(
                    page,
                    `[...document.querySelectorAll('${dialog} button')].some(button => button.textContent.trim() === 'Move to project…')`,
                ),
                false,
                "reader Options cannot move",
            );
            await page.evaluate(`await Promise.all(document.getAnimations()
                .filter(animation => animation.effect?.getComputedTiming().endTime !== Infinity)
                .map(animation => animation.finished.catch(() => {})))`);
            await page.press("Escape");
            await present(page, dialog, false);

            const pending = await beginTouch(page, home, fixture.worker);

            await present(page, overlay(home, fixture.worker));
            await finger(page, "touchmove", { x: pending.x + 16, y: pending.y });
            // Source removal before commit must cancel the pending Options timer.
            await page.evaluate(
                `document.querySelector(${JSON.stringify(row(home, fixture.worker))}).remove()`,
            );
            await pause(page, 850);
            await present(page, dialog, false);
            await finger(page, "touchend");
        } finally {
            await fixture.close();
        }
    },
);
