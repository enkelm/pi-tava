// Authoring gate: real browser move gestures/forms must deliver committed placement to peers.
// Risks: native drag cancelled by re-render, nested drops erase goals, partial failures lose selection,
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
const goalField = `${dialog} select[aria-label="Goal"]`;
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
const goal = (scope: string, id: string) => `${scope} .goal-section[data-goal-id="${id}"]`;
const head = (section: string) => `${section} > .project-group-head .group-head`;

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
        goalId: item.goalId ?? null,
    };
}

async function moved(
    fixture: Awaited<ReturnType<typeof setup>>,
    pages: BrowserPage[],
    scope: string,
    id: ConversationId,
    before: ReturnType<typeof metadata>,
    projectId: string | null,
    goalId: string | null = null,
) {
    await until(() => {
        const item = fixture.app.sessionMeta(id);

        return (item?.projectId ?? null) === projectId && (item?.goalId ?? null) === goalId;
    }, `committed placement for ${id}`);
    assert.deepEqual(metadata(fixture.app, id), { ...before, projectId, goalId });

    for (const page of pages) {
        await present(page, row(scope, id));
        // The untouched peer can relocate its row only through committed catalogue event delivery.
        await until(
            () =>
                value<boolean>(
                    page,
                    `(() => {
            const row = document.querySelector(${JSON.stringify(row(scope, id))});

            return (row.closest('.project-section:not(.goal-section)')?.dataset.projectId ?? null)
                    === ${JSON.stringify(projectId)}
                && (row.closest('.goal-section')?.dataset.goalId ?? null) === ${JSON.stringify(goalId)};
        })()`,
                ),
            `peer/UI placement for ${id}`,
        );
    }
}

async function shot(page: BrowserPage, name: string) {
    const directory = process.env.SESSION_MOVES_SCREENSHOT_DIR;

    if (directory === undefined) {
        return;
    }

    mkdirSync(directory, { recursive: true });
    await page.evaluate(`await Promise.all(document.getAnimations()
        .filter(animation => animation.effect?.getComputedTiming().endTime !== Infinity)
        .map(animation => animation.finished.catch(() => {})))`);
    const captured = await page.screenshot();

    writeFileSync(join(directory, `${name}.jpg`), Buffer.from(captured.data, "base64"));
}

async function nativeDrop(page: BrowserPage, source: string, target: string) {
    const start = await page.locate({ selector: source });

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
                throw new Error('Hover did not expand the collapsed goal');
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
    const seed = await app.commands.createSession(user, { projectId: beta.id, newGoal: true });
    const goalId = app.sessionMeta(seed.id)!.goalId!;
    const archived = await app.commands.createSession(user, { projectId: beta.id, newGoal: true });
    const archivedGoal = app.sessionMeta(archived.id)!.goalId!;

    await app.projects.updateGoal(user, goalId, { name: "Destination", status: "completed" });
    await app.projects.updateGoal(user, archivedGoal, {
        name: "Archived destination",
        archived: true,
    });
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
        await present(page, goal(scope, goalId));

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
        goalId,
        archivedGoal,
        worker: worker.id,
        chat: chat.id,
    };
}

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
                head(goal(sidebar, fixture.goalId)),
            );
            await moved(
                fixture,
                [page, peer],
                sidebar,
                fixture.worker,
                before,
                fixture.beta,
                fixture.goalId,
            );
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
            const destination = head(goal(sidebar, fixture.goalId));

            await click(page, destination);
            await selectRows(page, sidebar, [fixture.worker, fixture.chat]);
            fixture.denied.add(`/api/sessions/${fixture.chat}`);
            await drag(page, `${row(sidebar, fixture.worker)} .session`, destination, true);
            await moved(
                fixture,
                [page, peer],
                sidebar,
                fixture.worker,
                before,
                fixture.beta,
                fixture.goalId,
            );
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
            await moved(
                fixture,
                [page, peer],
                sidebar,
                fixture.chat,
                chatBefore,
                fixture.beta,
                fixture.goalId,
            );
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

            const open = async () => {
                await click(page, `${row(home, fixture.worker)} [aria-label="Move session"]`);
                await present(page, '[role="dialog"][aria-label="Move session"]');
            };

            const choose = async () => {
                await page.select({ selector: projectField }, fixture.beta);
                await present(page, goalField);
                assert.equal(
                    await value<boolean>(
                        page,
                        `[...document.querySelector(${JSON.stringify(goalField)}).options].some(option => option.value === ${JSON.stringify(fixture.archivedGoal)})`,
                    ),
                    false,
                    "archived goals are not destinations",
                );
                await page.select({ selector: goalField }, fixture.goalId);
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
            await moved(
                fixture,
                [page, peer],
                home,
                fixture.worker,
                before,
                fixture.beta,
                fixture.goalId,
            );
            await open();
            assert.equal(
                await value(page, `document.querySelector(${JSON.stringify(goalField)}).value`),
                fixture.goalId,
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
            assert.equal(
                await value<number>(
                    reader,
                    `document.querySelectorAll('${home} [aria-label="Move session"]').length`,
                ),
                0,
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
            await shot(reader, "mobile-reader");
        } finally {
            await fixture.close();
        }
    },
);
