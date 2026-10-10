// Queued edits in a real Chromium: the whole app, an isolated server, and a model held at a
// controllable boundary so queued inputs cannot disappear on a timer.
import {
    type App,
    cleanUp,
    fakeTab,
    lastText,
    newSession,
    openApp,
    owner,
    root,
    scriptedModel,
    until,
    work,
} from "./helpers.ts";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { createServer, type Server } from "node:http";
import { join } from "node:path";
import { after, before, test } from "node:test";
import { fauxAssistantMessage } from "@earendil-works/pi-ai/providers/faux";
import type { ConversationId, SubmissionId } from "@earendil-works/pi-durable";
import { Browsers } from "../src/server/browser.ts";
import { findBrowser } from "../src/server/browser/discovery.ts";
import type { BrowserPage } from "../src/server/browser/page.ts";
import { VIEWPORTS, type Viewport } from "../src/server/browser/viewport.ts";
import type { User } from "../src/server/config.ts";
import { ATTACHMENTS_HEADING } from "../src/server/entry-format.ts";
import { createHandler } from "../src/server/http.ts";

const chromium = findBrowser();
const real = {
    skip: chromium === undefined ? "no Chromium-based browser on this machine" : false,
} as const;
const TEXTAREA = ".composer textarea";
const PENCIL = ".queued .icon-button[aria-label='Edit queued message']";
const SAVE = "[aria-label='Save edit']";
const CANCEL = "[aria-label='Cancel edit']";
const QUEUE_TOGGLE = ".queue-toggle";
const STEER_TOGGLE = '[title="Steer joins the running work; off queues a follow-up"]';
const FULL_TEXT = `First line of the queued message.\n${"Full main text, not a preview. ".repeat(30)}\nLast line.`;
const LONG_PASTE = Array.from({ length: 25 }, (_, n) => `Original paste line ${n + 1}`).join("\n");

type Queued = { id: number; mode: string; text: string; editableText?: string };
type Draft = {
    text: string;
    start: number;
    end: number;
    direction: string;
    persisted: string | null;
    pastes: string | null;
    files: string[];
};
type Request = { path: string; body: Record<string, unknown>; status: number };
type Fixture = {
    id: ConversationId;
    followUp: SubmissionId;
    steer: SubmissionId;
    release: () => void;
};

let app: App;
let server: Server;
let browsers: Browsers;
let page: BrowserPage;
let base = "";
let collaborator: ReturnType<App["config"]["addUser"]>;
const sessions: ConversationId[] = [];
const gates = new Map<string, { entered: boolean; release?: () => void }>();
const requests: Request[] = [];

async function inPage<T>(script: string, on = page): Promise<T> {
    return JSON.parse(await on.evaluate(script)) as T;
}

const queued = () =>
    inPage<Queued[]>(`
        const { store } = await import('/store.js');

        return JSON.stringify(store.state.view.inbox);
    `);
const value = () =>
    inPage<string>(
        `return JSON.stringify(document.querySelector(${JSON.stringify(TEXTAREA)}).value)`,
    );
const editing = () =>
    inPage<boolean>(`return JSON.stringify(document.querySelector('.queue-edit-bar') !== null)`);
const disabled = (selector: string) =>
    inPage<boolean>(
        `return JSON.stringify(document.querySelector(${JSON.stringify(selector)}).disabled)`,
    );
const visible = (selector: string) =>
    inPage<boolean>(`
        const element = document.querySelector(${JSON.stringify(selector)});

        return JSON.stringify(!!element && element.getClientRects().length > 0 && getComputedStyle(element).visibility !== 'hidden');
    `);

async function draft(id: ConversationId): Promise<Draft> {
    return inPage<Draft>(`
        const element = document.querySelector(${JSON.stringify(TEXTAREA)});

        return JSON.stringify({
            text: element.value,
            start: element.selectionStart,
            end: element.selectionEnd,
            direction: element.selectionDirection,
            persisted: localStorage.getItem('pocket.draft.${id}'),
            pastes: localStorage.getItem('pocket.pastes.${id}'),
            files: [...document.querySelectorAll('.composer .files [aria-label^="Remove "]')].map(button => button.getAttribute('aria-label')),
        });
    `);
}

/** Actual HTTP commands observed at the server, excluding presence and typing traffic. */
const effectsSince = (start: number) =>
    requests
        .slice(start)
        .filter((request) =>
            /\/api\/(sessions$|c\/\d+\/(edit-queued|submit|shell|reset|configure|plan|withdraw|abort)$)/.test(
                request.path,
            ),
        );

async function rest(
    id: ConversationId,
    action: string,
    body: object,
    token = app.config.ownerToken,
) {
    return fetch(`${base}/api/c/${id}/${action}`, {
        method: "POST",
        headers: {
            Authorization: `Bearer ${token}`,
            "Content-Type": "application/json",
            "X-Pocket": "1",
        },
        body: JSON.stringify(body),
    });
}

/** Real submissions, paused inside the faux provider, with both queue modes and an attached file. */
async function fixture(): Promise<Fixture> {
    const id = await newSession(app);
    const key = `hold-ui:${crypto.randomUUID()}`;
    const gate: { entered: boolean; release?: () => void } = { entered: false };

    sessions.push(id);
    gates.set(key, gate);
    await app.commands.submit(id, owner(app), { text: key, requestId: crypto.randomUUID() });
    await until(() => gate.entered, "the controllable model boundary");
    const attached = join(work, "queued-attachment.txt");

    writeFileSync(attached, "An attachment that must not be replaced by the editor.\n");
    const followUp = await app.commands.submit(id, owner(app), {
        text: FULL_TEXT,
        mode: "followUp",
        requestId: crypto.randomUUID(),
        attachments: [
            { path: attached, name: "queued-attachment.txt", mime: "text/plain", size: 57 },
        ],
    });
    const steer = await app.commands.submit(id, owner(app), {
        text: "Original steer text",
        mode: "steer",
        requestId: crypto.randomUUID(),
    });

    return {
        id,
        followUp: followUp.submissionId,
        steer: steer.submissionId,
        release: () => gate.release?.(),
    };
}

async function open(
    fixture: Fixture,
    viewport: Viewport = VIEWPORTS.desktop,
    expectedCount = 2,
): Promise<void> {
    await page.setViewport(viewport);
    await page.navigate(`${base}/s/${fixture.id}`);
    await until(
        async () => (await queued()).length === expectedCount && (await visible(TEXTAREA)),
        "the composer and its queued inputs",
        20_000,
    );
    await until(
        async () =>
            await inPage<boolean>(
                "return JSON.stringify(document.documentElement.dataset.route === undefined)",
            ),
        "the route to finish sliding",
    );
}

async function begin(index = 0): Promise<void> {
    await showQueue();
    await page.click({
        selector: `.queued:nth-child(${index + 1}) [aria-label='Edit queued message']`,
    });
    await until(editing, "the queued edit bar");
}

async function restored(id: ConversationId, expected: Draft): Promise<void> {
    await until(
        async () => !(await editing()) && (await value()) === expected.text,
        "the restored draft",
    );

    try {
        await until(
            async () => (await draft(id)).start === expected.start,
            "the restored selection",
        );
    } catch {
        assert.deepEqual(
            await draft(id),
            expected,
            "the restored selection matches the previous draft",
        );
    }

    assert.deepEqual(
        await draft(id),
        expected,
        "text, selection, files, and pastes survive the edit",
    );
    assert.equal(
        await inPage<boolean>(
            `return JSON.stringify(document.activeElement === document.querySelector(${JSON.stringify(TEXTAREA)}))`,
        ),
        true,
        "the draft has focus again",
    );
}

async function prepareDraft(id: ConversationId): Promise<Draft> {
    await page.type({ selector: TEXTAREA }, "Unsent draft with its own paste: ");
    await page.evaluate(`
        const element = document.querySelector(${JSON.stringify(TEXTAREA)});
        const clipboard = new DataTransfer();

        clipboard.setData('text/plain', ${JSON.stringify(LONG_PASTE)});
        element.dispatchEvent(new ClipboardEvent('paste', { bubbles: true, cancelable: true, clipboardData: clipboard }));
        const input = document.querySelector('.composer input[type=file]');
        const files = new DataTransfer();

        files.items.add(new File(['keep this draft attachment'], 'draft-only.txt', { type: 'text/plain' }));
        input.files = files.files;
        input.dispatchEvent(new Event('change', { bubbles: true }));
    `);
    await until(
        async () =>
            (await visible('[aria-label="Remove draft-only.txt"]')) &&
            !(await disabled('[aria-label="Send"]')),
        "the draft's uploaded file",
    );
    await page.evaluate(`
        const element = document.querySelector(${JSON.stringify(TEXTAREA)});

        element.focus();
        element.setSelectionRange(3, 12, 'backward');
    `);
    const previous = await draft(id);

    assert.match(previous.text, /\[Pasted text #1/);
    assert.deepEqual(JSON.parse(previous.pastes!), { 1: LONG_PASTE });
    assert.deepEqual(previous.files, ["Remove draft-only.txt"]);

    return previous;
}

/** Optional review captures, as in the other real-browser tests. */
async function shot(name: string): Promise<void> {
    const directory = process.env.QUEUED_EDIT_SCREENSHOT_DIR;

    if (directory === undefined) {
        return;
    }

    mkdirSync(directory, { recursive: true });
    const captured = await page.screenshot();

    writeFileSync(join(directory, `${name}.jpg`), Buffer.from(captured.data, "base64"));
}

/** The bar and every edit control stay on screen; the composer never widens the viewport. */
async function layout(width: number): Promise<void> {
    // Save enters with a scale animation. Measure its resting hit area, not a smaller intermediate frame.
    await page.evaluate(`
        await Promise.all(document.getAnimations()
            .filter(animation => Number.isFinite(animation.effect.getComputedTiming().endTime))
            .map(animation => animation.finished.catch(() => {})));
    `);
    const measured = await inPage<{
        widest: number;
        composer: number;
        controls: {
            selector: string;
            x: number;
            right: number;
            y: number;
            bottom: number;
            w: number;
            h: number;
            hit: boolean;
        }[];
        height: number;
    }>(`
        const composer = document.querySelector('.composer');
        const controls = ${JSON.stringify([".queue-edit-bar", TEXTAREA, SAVE, CANCEL])}.map(selector => {
            const element = document.querySelector(selector);
            const rect = element.getBoundingClientRect();
            const hit = document.elementFromPoint(rect.x + rect.width / 2, rect.y + rect.height / 2);

            return { selector, x: rect.x, right: rect.right, y: rect.y, bottom: rect.bottom, w: rect.width, h: rect.height, hit: element.contains(hit) };
        });

        return JSON.stringify({
            widest: Math.max(document.documentElement.scrollWidth, document.body.scrollWidth),
            composer: composer.scrollWidth,
            controls,
            height: innerHeight,
        });
    `);

    assert.ok(measured.widest <= width, `no page overflow: ${JSON.stringify(measured)}`);
    assert.ok(measured.composer <= width, "the composer does not overflow");

    for (const control of measured.controls) {
        assert.ok(control.w > 0 && control.h > 0, `${control.selector} is laid out`);
        assert.ok(
            control.x >= 0 && control.right <= width + 1,
            `${control.selector} fits horizontally`,
        );
        assert.ok(
            control.y >= 0 && control.bottom <= measured.height + 1,
            `${control.selector} fits vertically`,
        );
        assert.ok(control.hit, `${control.selector} is not covered`);

        if (width === VIEWPORTS.mobile.width && [SAVE, CANCEL].includes(control.selector)) {
            assert.ok(
                control.w >= 40 && control.h >= 40,
                `${control.selector} takes a thumb: ${JSON.stringify(control)}`,
            );
        }
    }
}

type Box = {
    x: number;
    y: number;
    right: number;
    bottom: number;
    width: number;
    height: number;
    hit: boolean;
};

async function box(selector: string): Promise<Box> {
    return inPage<Box>(`
        const element = document.querySelector(${JSON.stringify(selector)});
        const rect = element.getBoundingClientRect();
        const hit = document.elementFromPoint(rect.x + rect.width / 2, rect.y + rect.height / 2);

        return JSON.stringify({ x: rect.x, y: rect.y, right: rect.right, bottom: rect.bottom, width: rect.width, height: rect.height, hit: element.contains(hit) });
    `);
}

type QueueState = {
    toggle: boolean;
    expanded: string | null;
    label: string;
    controls: string | null;
    controlsInbox: boolean;
    hidden: boolean;
    visible: boolean;
    disabled: boolean;
};

async function queueState(): Promise<QueueState> {
    return inPage<QueueState>(`
        const toggle = document.querySelector(${JSON.stringify(QUEUE_TOGGLE)});
        const inbox = document.querySelector('.queue .inbox');
        const controls = toggle?.getAttribute('aria-controls') ?? null;

        return JSON.stringify({
            toggle: toggle !== null,
            expanded: toggle?.getAttribute('aria-expanded') ?? null,
            label: toggle?.textContent.trim() ?? '',
            controls,
            controlsInbox: !!controls && document.getElementById(controls) === inbox,
            hidden: inbox?.hidden ?? false,
            visible: !!inbox && inbox.getClientRects().length > 0,
            disabled: toggle?.disabled ?? false,
        });
    `);
}

async function queueExpanded(expanded: boolean): Promise<void> {
    await until(
        async () => {
            const state = await queueState();

            return (
                state.expanded === String(expanded) &&
                state.hidden === !expanded &&
                state.visible === expanded
            );
        },
        `the queue to be ${expanded ? "expanded" : "collapsed"}`,
    );
}

/** Existing row/edit regressions explicitly open a collapsible queue before inspecting it. */
async function showQueue(): Promise<void> {
    const state = await queueState();

    if (!state.toggle || state.visible) {
        return;
    }

    // Keyboard activation avoids desktop hover opening the toggle just before the click.
    await page.evaluate(`document.querySelector(${JSON.stringify(QUEUE_TOGGLE)}).focus()`);
    await page.press("Enter");
    await queueExpanded(true);
}

/** Add another real queued input without releasing the fixture's model boundary. */
async function addQueued(
    f: Fixture,
    text: string,
    mode: "steer" | "followUp" = "followUp",
    user: User = owner(app),
): Promise<SubmissionId> {
    const submitted = await app.commands.submit(f.id, user, {
        text,
        mode,
        requestId: crypto.randomUUID(),
    });

    return submitted.submissionId;
}

/** Queue rows keep their natural height and readable modes while the inbox takes bounded space. */
async function inboxLayout(viewport: Viewport, count: number, scrolls = false): Promise<void> {
    await showQueue();
    const measured = await inPage<{
        widest: number;
        y: number;
        bottom: number;
        height: number;
        viewportHeight: number;
        scrollHeight: number;
        clientHeight: number;
        scrollWidth: number;
        clientWidth: number;
        overflowY: string;
        rows: {
            mode: string;
            height: number;
            modeFits: boolean;
            buttonsFit: boolean;
            previewWidth: number;
        }[];
    }>(`
        const inbox = document.querySelector('.inbox');
        const box = inbox.getBoundingClientRect();
        const rows = [...inbox.querySelectorAll('.queued')].map(row => {
            const rect = row.getBoundingClientRect();
            const mode = row.querySelector('.queued-mode');
            const modeRect = mode.getBoundingClientRect();
            const node = [...mode.childNodes].find(node => node.nodeType === Node.TEXT_NODE && node.textContent.trim());
            const text = node.textContent;
            const range = document.createRange();

            range.setStart(node, text.search(/\\S/));
            range.setEnd(node, text.trimEnd().length);
            const label = range.getBoundingClientRect();
            const buttonsFit = [...row.querySelectorAll('button')].every(button => {
                const buttonRect = button.getBoundingClientRect();

                return buttonRect.left >= rect.left && buttonRect.right <= rect.right && buttonRect.top >= rect.top && buttonRect.bottom <= rect.bottom;
            });

            return {
                mode: text.trim(),
                height: rect.height,
                modeFits: label.left >= modeRect.left - 1 && label.right <= modeRect.right + 1 && label.top >= rect.top && label.bottom <= rect.bottom,
                buttonsFit,
                previewWidth: row.querySelector('.queued-text').getBoundingClientRect().width,
            };
        });

        return JSON.stringify({
            widest: Math.max(document.documentElement.scrollWidth, document.body.scrollWidth),
            y: box.y,
            bottom: box.bottom,
            height: box.height,
            viewportHeight: innerHeight,
            scrollHeight: inbox.scrollHeight,
            clientHeight: inbox.clientHeight,
            scrollWidth: inbox.scrollWidth,
            clientWidth: inbox.clientWidth,
            overflowY: getComputedStyle(inbox).overflowY,
            rows,
        });
    `);

    assert.ok(
        measured.widest <= viewport.width,
        `the queue never widens the page: ${JSON.stringify(measured)}`,
    );
    assert.ok(
        measured.scrollWidth <= measured.clientWidth,
        "the inbox does not scroll horizontally",
    );
    assert.ok(
        measured.y >= 0 && measured.bottom <= measured.viewportHeight,
        "the inbox fits on screen",
    );
    assert.ok(
        measured.height <= measured.viewportHeight * 0.25 + 1,
        "the inbox uses at most a quarter of the viewport",
    );
    assert.equal(measured.rows.length, count);

    for (const row of measured.rows) {
        assert.ok(["Queued", "Steer"].includes(row.mode), `the mode remains readable: ${row.mode}`);
        assert.ok(row.modeFits, `the ${row.mode} label is not clipped by the author`);
        assert.ok(
            row.height >= (viewport.mobile ? 40 : 24),
            "queue rows do not shrink into slivers",
        );
        assert.ok(row.buttonsFit, "queue controls fit inside their row");
        assert.ok(
            row.previewWidth >= 20,
            "the message preview still has room beside its mode and author",
        );
    }

    if (scrolls) {
        assert.ok(
            measured.scrollHeight > measured.clientHeight,
            "seven rows scroll rather than expanding the inbox",
        );
        assert.ok(
            ["auto", "scroll"].includes(measured.overflowY),
            "the bounded inbox can be scrolled",
        );
    }
}

before(async () => {
    if (chromium === undefined) {
        return;
    }

    app = await openApp(
        scriptedModel(async (request, options) => {
            const key = lastText(request as never).text.match(/hold-ui:[\w-]+/)?.[0];
            const gate = key === undefined ? undefined : gates.get(key);

            if (gate !== undefined && !gate.entered) {
                gate.entered = true;
                await new Promise<void>((resolve) => {
                    gate.release = resolve;

                    if (options?.signal?.aborted) {
                        resolve();
                    } else {
                        options?.signal?.addEventListener("abort", () => resolve(), { once: true });
                    }
                });
            }

            return fauxAssistantMessage("Fixture response.");
        }),
    );
    collaborator = app.config.addUser("Queue collaborator", "guest");
    const handler = createHandler({
        app,
        listen: { host: "127.0.0.1", port: 0 },
        restart: () => {},
    });

    server = createServer((request, response) => {
        if (request.method === "POST") {
            const chunks: Buffer[] = [];
            const observed: Request = { path: request.url ?? "", body: {}, status: 0 };

            requests.push(observed);
            request.on("data", (chunk: Buffer) => chunks.push(chunk));
            request.on("end", () => {
                if (request.headers["content-type"]?.includes("application/json")) {
                    observed.body = JSON.parse(Buffer.concat(chunks).toString());
                }
            });
            response.on("finish", () => {
                observed.status = response.statusCode;
            });
        }

        void handler(request, response);
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    base = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
    browsers = new Browsers({
        dataDir: mkdtempSync(join(root, "queued-edit-ui-")),
        load: async () => undefined,
        save: () => {},
    });
    page = await browsers.open(1);
    await page.setViewport(VIEWPORTS.desktop);
    await page.navigate(`${base}/login?token=${encodeURIComponent(app.config.ownerToken)}`);
});

after(async () => {
    await Promise.all(sessions.map((id) => app.commands.abort(id, owner(app)).catch(() => {})));

    for (const gate of gates.values()) {
        gate.release?.();
    }

    if (app !== undefined) {
        await until(
            () => sessions.every((id) => !app.isBusy(id)),
            "the fixture runs to stop",
        ).catch(() => {});
    }

    await browsers?.closeAll({ final: true });
    server?.closeAllConnections();
    server?.close();
    await app?.close();
    cleanUp();
});

test(
    "Enter edits the full queued follow-up literally in place and restores the separate draft",
    real,
    async () => {
        const f = await fixture();

        await open(f);
        await page.click({ selector: STEER_TOGGLE });
        assert.equal(
            await inPage<boolean>(
                `return JSON.stringify(document.querySelector(${JSON.stringify(STEER_TOGGLE)}).classList.contains('on'))`,
            ),
            false,
            "the normal composer is set to queue follow-ups",
        );
        const before = await queued();
        const previous = await prepareDraft(f.id);
        const start = requests.length;

        assert.deepEqual(
            before.map(({ id, mode }) => ({ id, mode })),
            [
                { id: Number(f.followUp), mode: "followUp" },
                { id: Number(f.steer), mode: "steer" },
            ],
        );
        assert.match(before[0]!.text, /^\[from: /);
        assert.ok(before[0]!.text.includes(ATTACHMENTS_HEADING));
        await begin();
        assert.equal(
            await value(),
            FULL_TEXT,
            "editable text is complete, without author or attachment metadata",
        );
        assert.match(
            await inPage<string>(
                "return JSON.stringify(document.querySelector('.queue-edit-bar').textContent)",
            ),
            /Editing queued follow-up/,
        );
        assert.equal(
            (await draft(f.id)).persisted,
            previous.persisted,
            "opening the editor never overwrites the draft",
        );

        for (const selector of [
            '[aria-label="Attach files"]',
            ".composer .files",
            ".composer .model-chip",
            ".composer .toggle",
            ".composer .commands",
            '[aria-label="Send"]',
        ]) {
            assert.equal(await visible(selector), false, `${selector} is hidden during editing`);
        }

        await layout(VIEWPORTS.desktop.width);
        await shot("queued-edit-desktop");
        await page.type({ selector: TEXTAREA }, "/new");
        await page.press("Shift+Enter");
        await page.type(undefined, "!printf this-is-literal", { append: true });
        assert.equal(await value(), "/new\n!printf this-is-literal");
        assert.equal(
            await visible(".composer .commands"),
            false,
            "slash commands never appear in an edit",
        );
        assert.equal(
            await visible(".composer .command-hint"),
            false,
            "shell controls never appear in an edit",
        );
        assert.deepEqual(effectsSince(start), [], "Shift+Enter only inserts a newline");
        await page.press("Enter");
        await restored(f.id, previous);
        assert.equal(
            await inPage<boolean>(
                `return JSON.stringify(document.querySelector(${JSON.stringify(STEER_TOGGLE)}).classList.contains('on'))`,
            ),
            false,
            "saving restores the original composer mode",
        );
        await until(
            async () => (await queued())[0]?.editableText === "/new\n!printf this-is-literal",
            "the committed queued edit",
        );
        const after = await queued();

        assert.deepEqual(
            after.map(({ id, mode }) => ({ id, mode })),
            before.map(({ id, mode }) => ({ id, mode })),
            "queue IDs, modes, and order do not change",
        );
        assert.equal(after[1]!.editableText, "Original steer text");
        assert.equal(
            after[0]!.text,
            before[0]!.text.replace(FULL_TEXT, "/new\n!printf this-is-literal"),
            "speaker and attachment metadata stay intact",
        );
        assert.deepEqual(
            effectsSince(start),
            [
                {
                    path: `/api/c/${f.id}/edit-queued`,
                    body: {
                        submissionId: Number(f.followUp),
                        text: "/new\n!printf this-is-literal",
                        expectedText: FULL_TEXT,
                    },
                    status: 200,
                },
            ],
            "the only command is an in-place edit, not a new session, message, or shell command",
        );
    },
);

test(
    "Cancel and Escape from composer, queue, or header controls restore the draft without stopping Pi",
    real,
    async () => {
        const f = await fixture();

        await open(f);
        const previous = await prepareDraft(f.id);
        const before = await queued();
        const start = requests.length;

        for (const cancel of ["button", "save", "withdraw", "header"] as const) {
            await begin(1);
            assert.equal(await value(), "Original steer text");
            assert.match(
                await inPage<string>(
                    "return JSON.stringify(document.querySelector('.queue-edit-bar').textContent)",
                ),
                /Editing steer/,
            );
            await page.type({ selector: TEXTAREA }, "Changes that must not be saved");

            if (cancel === "button") {
                await page.click({ selector: CANCEL });
            } else {
                const target = {
                    save: SAVE,
                    withdraw: '.queued:nth-child(1) [aria-label="Withdraw"]',
                    header: '.topbar [aria-label="Files"]',
                }[cancel];

                await page.evaluate(`document.querySelector(${JSON.stringify(target)}).focus()`);
                assert.equal(
                    await inPage<boolean>(
                        `return JSON.stringify(document.activeElement === document.querySelector(${JSON.stringify(target)}))`,
                    ),
                    true,
                    `${cancel} takes focus outside the textarea`,
                );
                await page.press("Escape");
            }

            await restored(f.id, previous);
            assert.deepEqual(await queued(), before, "cancelling never changes the queue");
            assert.equal(app.isBusy(f.id), true, "a cancelling Escape never stops Pi");
        }

        // One ordinary Escape after cancellation must still be only the first Escape of the stop shortcut.
        await page.evaluate(`document.querySelector('.topbar [aria-label="Files"]').focus()`);
        await page.press("Escape");
        assert.equal(
            app.isBusy(f.id),
            true,
            "cancelling did not prime the double-Escape stop shortcut",
        );
        assert.deepEqual(
            effectsSince(start),
            [],
            "cancellation never sends, withdraws, or stops anything",
        );
    },
);

test(
    "composing Enter and blank edits do not save; a leading ! is saved literally",
    real,
    async () => {
        const f = await fixture();

        await open(f);
        await page.type({ selector: TEXTAREA }, "Draft before IME input");
        const previous = await draft(f.id);
        const start = requests.length;

        await begin(1);
        await page.type({ selector: TEXTAREA }, "   ");
        assert.equal(await disabled(SAVE), true);
        await page.press("Enter");
        assert.equal(await editing(), true);
        await page.type({ selector: TEXTAREA }, "!echo 日本語");
        await page.evaluate(`
        const element = document.querySelector(${JSON.stringify(TEXTAREA)});

        element.dispatchEvent(new CompositionEvent('compositionstart', { bubbles: true }));
        element.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', code: 'Enter', isComposing: true, bubbles: true, cancelable: true }));
        element.dispatchEvent(new CompositionEvent('compositionend', { data: '日本語', bubbles: true }));
        element.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', code: 'Enter', keyCode: 229, bubbles: true, cancelable: true }));
    `);
        assert.equal(
            await editing(),
            true,
            "Enter used to confirm IME input leaves the editor open",
        );
        assert.equal(await value(), "!echo 日本語");
        assert.deepEqual(effectsSince(start), []);
        await page.press("Enter");
        await restored(f.id, previous);
        await until(
            async () => (await queued())[1]?.editableText === "!echo 日本語",
            "the literal steer edit",
        );
        assert.deepEqual(
            effectsSince(start).map(({ path, body }) => ({ path, body })),
            [
                {
                    path: `/api/c/${f.id}/edit-queued`,
                    body: {
                        submissionId: Number(f.steer),
                        text: "!echo 日本語",
                        expectedText: "Original steer text",
                    },
                },
            ],
        );
    },
);

test(
    "attachment-only and whitespace edits keep queued attachments and restore the draft",
    real,
    async () => {
        const f = await fixture();

        await open(f);
        const before = await queued();
        const previous = await prepareDraft(f.id);
        const start = requests.length;

        for (const text of ["", "   "]) {
            await begin();
            await page.type({ selector: TEXTAREA }, text);
            assert.equal(await disabled(SAVE), false, "an attached input may have blank main text");
            await page.click({ selector: SAVE });
            await restored(f.id, previous);
            await until(
                async () => (await queued())[0]?.editableText === text,
                "the attachment-only edit",
            );
            const after = await queued();

            assert.deepEqual(
                after.map(({ id, mode }) => ({ id, mode })),
                before.map(({ id, mode }) => ({ id, mode })),
            );
            assert.equal(
                after[0]!.text,
                before[0]!.text.replace(FULL_TEXT, text),
                "blanking the text does not delete the attached file or speaker",
            );
        }

        assert.deepEqual(
            effectsSince(start).map(({ body }) => body),
            [
                { submissionId: Number(f.followUp), text: "", expectedText: FULL_TEXT },
                { submissionId: Number(f.followUp), text: "   ", expectedText: "" },
            ],
            "both blanks are saved literally, without a new submission",
        );
    },
);

test(
    "long pastes and draft-like placeholders in edits are saved literally rather than folded or expanded",
    real,
    async () => {
        const f = await fixture();

        await open(f);
        const previous = await prepareDraft(f.id);

        await begin(1);
        await page.type({ selector: TEXTAREA }, "");
        const prevented = await inPage<boolean>(`
        const element = document.querySelector(${JSON.stringify(TEXTAREA)});
        const clipboard = new DataTransfer();

        clipboard.setData('text/plain', ${JSON.stringify(LONG_PASTE)});
        const event = new ClipboardEvent('paste', { bubbles: true, cancelable: true, clipboardData: clipboard });

        element.dispatchEvent(event);

        return JSON.stringify(event.defaultPrevented);
    `);

        assert.equal(
            prevented,
            false,
            "editing lets the browser insert a long paste instead of folding it",
        );
        // Untrusted ClipboardEvents have no default insertion. Input.insertText supplies the browser's text input.
        const text = `${LONG_PASTE}\n[Pasted text #1]`;
        const start = requests.length;

        await page.type(undefined, text, { append: true });
        assert.equal(
            await value(),
            text,
            "the edit keeps the pasted lines and literal placeholder",
        );
        assert.equal(
            (await draft(f.id)).pastes,
            previous.pastes,
            "the draft's paste map is separate",
        );
        await page.press("Enter");
        await restored(f.id, previous);
        await until(
            async () => (await queued())[1]?.editableText === text,
            "the literal pasted edit",
        );
        assert.deepEqual(
            effectsSince(start).map(({ body }) => body),
            [
                {
                    submissionId: Number(f.steer),
                    text,
                    expectedText: "Original steer text",
                },
            ],
        );
    },
);

test(
    "phone edit controls fit without overflow and Save works on the touch-sized button",
    real,
    async () => {
        const f = await fixture();

        await open(f, VIEWPORTS.mobile);
        await page.type({ selector: TEXTAREA }, "Phone draft");
        const previous = await draft(f.id);

        await begin(1);
        assert.equal(
            await inPage<boolean>("return JSON.stringify(matchMedia('(pointer: coarse)').matches)"),
            true,
        );
        await layout(VIEWPORTS.mobile.width);
        await shot("queued-edit-mobile");
        await page.type({ selector: TEXTAREA }, `!literal ${"long-unbroken-text".repeat(50)}`);
        await layout(VIEWPORTS.mobile.width);
        const start = requests.length;

        await page.click({ selector: SAVE });
        await restored(f.id, previous);
        await until(
            async () => (await queued())[1]?.editableText?.startsWith("!literal ") === true,
            "the phone's saved edit",
        );
        assert.equal(effectsSince(start).length, 1);
        assert.equal(effectsSince(start)[0]!.path, `/api/c/${f.id}/edit-queued`);
        assert.equal((await queued())[1]!.id, Number(f.steer));
        assert.equal((await queued())[1]!.mode, "steer");
    },
);

test(
    "a stale failed save keeps the editor text and original draft for cancellation",
    real,
    async () => {
        const f = await fixture();

        await open(f);
        const previous = await prepareDraft(f.id);

        await begin();
        await page.type({ selector: TEXTAREA }, "My unsaved changes");
        const remote = await rest(f.id, "edit-queued", {
            submissionId: Number(f.followUp),
            text: "Changed by another tab",
            expectedText: FULL_TEXT,
        });

        assert.equal(remote.status, 200);
        await until(
            async () => (await queued())[0]?.editableText === "Changed by another tab",
            "the other tab's edit",
        );
        const start = requests.length;

        await page.click({ selector: SAVE });
        await until(
            () => effectsSince(start).some(({ status }) => status === 409),
            "the stale save conflict",
        );
        await until(
            async () => !(await disabled(SAVE)),
            "the failed save to leave the editor usable",
        );
        assert.equal(await editing(), true);
        assert.equal(await value(), "My unsaved changes");
        assert.equal((await draft(f.id)).persisted, previous.persisted);
        assert.equal((await draft(f.id)).pastes, previous.pastes);
        assert.equal((await queued())[0]!.editableText, "Changed by another tab");
        assert.equal(effectsSince(start).length, 1, "no fallback new submission after failure");
        await page.click({ selector: CANCEL });
        await restored(f.id, previous);
    },
);

test(
    "an input consumed while editing stays in the editor with Save disabled and is never resent",
    real,
    async () => {
        const f = await fixture();

        await open(f);
        await page.type({ selector: TEXTAREA }, "Draft kept when the queue disappears");
        const previous = await draft(f.id);

        await begin();
        await page.type({ selector: TEXTAREA }, "Do not send this as a new message");
        f.release();
        await until(
            async () => (await queued()).length === 0 && (await disabled(SAVE)),
            "the consumed inputs and disabled Save",
        );
        assert.equal(await editing(), true);
        assert.equal(await value(), "Do not send this as a new message");
        assert.match(
            await inPage<string>(
                "return JSON.stringify(document.querySelector('.queue-edit-warning')?.textContent ?? '')",
            ),
            /no longer queued/i,
        );
        const start = requests.length;

        await page.press("Enter");
        await page.click({ selector: SAVE });
        assert.equal(await editing(), true);
        assert.deepEqual(
            effectsSince(start),
            [],
            "neither Enter nor the disabled button resends the input",
        );
        await page.evaluate(`document.querySelector(${JSON.stringify(CANCEL)}).focus()`);
        await page.press("Escape");
        await restored(f.id, previous);
    },
);

test(
    "a blocked nondriver cannot edit even their own queued input, and viewers cannot edit",
    real,
    async () => {
        const f = await fixture();
        const own = await app.commands.submit(f.id, collaborator.user, {
            text: "The collaborator's own queued input",
            mode: "followUp",
            requestId: crypto.randomUUID(),
        });
        const driver = fakeTab(f.id, owner(app));

        await app.attach(driver.client);
        await app.collab.turns(f.id, owner(app), { action: "on" });
        const guestPage = await browsers.open(2);

        try {
            await guestPage.setViewport(VIEWPORTS.mobile);
            await guestPage.navigate(
                `${base}/login?token=${encodeURIComponent(collaborator.token)}`,
            );
            await guestPage.navigate(`${base}/s/${f.id}`);
            await until(
                async () =>
                    await inPage<boolean>(
                        "return JSON.stringify(document.querySelectorAll('.queued').length === 3 && document.querySelector('.driver-bar') !== null)",
                        guestPage,
                    ),
                "the nondriver's queued inputs",
            );
            assert.equal(
                await inPage<number>(
                    `return JSON.stringify(document.querySelectorAll(${JSON.stringify(PENCIL)}).length)`,
                    guestPage,
                ),
                0,
            );
            assert.equal(
                await inPage<boolean>(
                    `return JSON.stringify(document.querySelector(${JSON.stringify(TEXTAREA)}) === null && document.querySelector(${JSON.stringify(SAVE)}) === null)`,
                    guestPage,
                ),
                true,
                "the blocked composer has no editor",
            );
            const denied = await rest(
                f.id,
                "edit-queued",
                {
                    submissionId: Number(own.submissionId),
                    text: "Not allowed",
                    expectedText: "The collaborator's own queued input",
                },
                collaborator.token,
            );

            assert.equal(denied.status, 409);
            assert.match(await denied.text(), /is driving/);
            const viewer = app.config.addUser("Queue viewer", "viewer");

            await guestPage.navigate(`${base}/login?token=${encodeURIComponent(viewer.token)}`);
            await guestPage.navigate(`${base}/s/${f.id}`);
            await until(
                async () =>
                    await inPage<boolean>(
                        "return JSON.stringify(document.querySelectorAll('.queued').length === 3)",
                        guestPage,
                    ),
                "the viewer's queued inputs",
            );
            assert.equal(
                await inPage<number>(
                    `return JSON.stringify(document.querySelectorAll(${JSON.stringify(PENCIL)}).length)`,
                    guestPage,
                ),
                0,
            );
        } finally {
            app.detach(driver.client);
            await browsers.close(2);
        }
    },
);

test(
    "desktop queue hover expands above the anchored bar; leaving closes unless clicked open",
    real,
    async () => {
        const f = await fixture();

        await addQueued(f, "Third queued input");
        await open(f, VIEWPORTS.desktop, 3);
        await page.type({ selector: TEXTAREA }, "Hover leaves this draft alone");
        await page.hover({ selector: '.topbar [aria-label="Files"]' });
        await queueExpanded(false);
        const previous = await draft(f.id);
        const before = await queued();
        const start = requests.length;
        const collapsed = await box(QUEUE_TOGGLE);

        await shot("queue-collapse-desktop-collapsed");
        await page.evaluate(`
        document.querySelector('.queue').dispatchEvent(new PointerEvent('pointerenter', { pointerType: 'touch' }));
    `);
        assert.equal(
            (await queueState()).expanded,
            "false",
            "a touch pointer does not trigger desktop hover",
        );
        await page.hover({ selector: QUEUE_TOGGLE });
        await queueExpanded(true);
        const expanded = await box(QUEUE_TOGGLE);
        const inbox = await box(".inbox");

        assert.ok(expanded.y >= inbox.bottom - 1, "the toggle bar is below the rows");
        assert.ok(
            Math.abs(expanded.y - collapsed.y) <= 1,
            "rows grow upward without moving the hover target",
        );
        assert.ok(expanded.hit, "the expanded bar stays under the pointer");
        assert.match((await queueState()).label, /Hide/i);
        await inboxLayout(VIEWPORTS.desktop, 3);
        await shot("queue-collapse-desktop-expanded");
        await page.hover({ selector: TEXTAREA });
        await queueExpanded(false);
        await page.hover({ selector: QUEUE_TOGGLE });
        await queueExpanded(true);
        await page.click({ selector: QUEUE_TOGGLE });
        await queueExpanded(false);
        await page.click({ selector: QUEUE_TOGGLE });
        await queueExpanded(true);
        await page.hover({ selector: '.topbar [aria-label="Files"]' });
        await queueExpanded(true);
        await page.click({ selector: QUEUE_TOGGLE });
        await queueExpanded(false);
        await page.click({ selector: QUEUE_TOGGLE });
        await queueExpanded(true);
        await page.click({ selector: TEXTAREA });
        await queueExpanded(false);
        assert.deepEqual(
            await queued(),
            before,
            "hover and toggling keep every queued ID and text",
        );
        assert.equal((await draft(f.id)).text, previous.text);
        assert.equal((await draft(f.id)).persisted, previous.persisted);
        assert.deepEqual(effectsSince(start), [], "queue visibility changes execute no commands");
    },
);

test(
    "queue row focus retains hover expansion; Enter, Space, and Escape toggle without stopping Pi",
    real,
    async () => {
        const f = await fixture();

        await addQueued(f, "Third queued input");
        await open(f, VIEWPORTS.desktop, 3);
        await page.type({ selector: TEXTAREA }, "Keyboard queue draft");
        await page.hover({ selector: '.topbar [aria-label="Files"]' });
        await queueExpanded(false);
        const before = await queued();
        const previous = await draft(f.id);
        const start = requests.length;

        await page.hover({ selector: QUEUE_TOGGLE });
        await queueExpanded(true);
        await page.evaluate(`document.querySelector('.queued [aria-label="Withdraw"]').focus()`);
        await page.hover({ selector: '.topbar [aria-label="Files"]' });
        await queueExpanded(true);
        await page.press("Escape");
        await queueExpanded(false);
        assert.equal(app.isBusy(f.id), true, "Escape from a queue row does not stop the model");
        await page.evaluate(`document.querySelector(${JSON.stringify(QUEUE_TOGGLE)}).focus()`);
        await page.press("Enter");
        await queueExpanded(true);
        await page.press("Space");
        await queueExpanded(false);
        await page.press("Space");
        await queueExpanded(true);
        await page.press("Escape");
        await queueExpanded(false);
        await page.evaluate(`document.querySelector('.topbar [aria-label="Files"]').focus()`);
        await page.press("Escape");
        assert.equal(
            app.isBusy(f.id),
            true,
            "queue Escapes did not prime the double-Escape stop shortcut",
        );
        assert.deepEqual(await queued(), before);
        assert.deepEqual(
            await draft(f.id),
            previous,
            "keyboard navigation does not overwrite or send the draft",
        );
        assert.deepEqual(effectsSince(start), []);
    },
);

test(
    "phone queue taps toggle a thumb-sized bar and tapping the input closes the pinned list",
    real,
    async () => {
        const f = await fixture();

        await addQueued(f, "Third queued input");
        await open(f, VIEWPORTS.mobile, 3);
        await page.type({ selector: TEXTAREA }, "Phone queue draft");
        await queueExpanded(false);
        const before = await queued();
        const previous = await draft(f.id);
        const start = requests.length;
        const toggle = await box(QUEUE_TOGGLE);

        assert.ok(toggle.height >= 40 && toggle.width >= 40, "the queue toggle takes a thumb");
        assert.ok(
            toggle.hit && toggle.x >= 0 && toggle.right <= VIEWPORTS.mobile.width,
            "the collapsed toggle fits and is reachable",
        );
        await shot("queue-collapse-mobile-collapsed");
        await page.evaluate(`
        document.querySelector('.queue').dispatchEvent(new PointerEvent('pointerenter', { pointerType: 'touch' }));
    `);
        await queueExpanded(false);
        await page.click({ selector: QUEUE_TOGGLE });
        await queueExpanded(true);
        await inboxLayout(VIEWPORTS.mobile, 3);
        await shot("queue-collapse-mobile-expanded");
        await page.click({ selector: QUEUE_TOGGLE });
        await queueExpanded(false);
        await page.click({ selector: QUEUE_TOGGLE });
        await queueExpanded(true);
        await page.click({ selector: TEXTAREA });
        await queueExpanded(false);
        assert.deepEqual(await queued(), before);
        assert.equal((await draft(f.id)).text, previous.text);
        assert.equal((await draft(f.id)).persisted, previous.persisted);
        assert.deepEqual(
            effectsSince(start),
            [],
            "mobile queue taps never submit or withdraw messages",
        );
    },
);

test(
    "removing the focused queue row re-collapses the remaining long queue without needing blur",
    real,
    async () => {
        const f = await fixture();

        await addQueued(f, "Third queued input");
        const fourth = await addQueued(f, "Focused fourth queued input");

        await open(f, VIEWPORTS.desktop, 4);
        await page.type({ selector: TEXTAREA }, "Draft survives focused withdrawal");
        await page.hover({ selector: '.topbar [aria-label="Files"]' });
        await queueExpanded(false);
        const before = await queued();
        const previous = await draft(f.id);
        const start = requests.length;

        await page.hover({ selector: QUEUE_TOGGLE });
        await queueExpanded(true);
        await page.evaluate(
            `document.querySelector('.queued:nth-child(4) [aria-label="Withdraw"]').focus()`,
        );
        await page.hover({ selector: '.topbar [aria-label="Files"]' });
        await queueExpanded(true);
        const withdrawn = await rest(f.id, "withdraw", { submissionId: Number(fourth) });

        assert.equal(withdrawn.status, 200);
        await until(async () => (await queued()).length === 3, "the focused row to be withdrawn");
        await queueExpanded(false);
        assert.match((await queueState()).label, /3\s+queued messages/i);
        assert.deepEqual(await queued(), before.slice(0, 3), "the remaining queue is unchanged");
        assert.deepEqual(await draft(f.id), previous);
        assert.deepEqual(
            effectsSince(start).map(({ path, body }) => ({ path, body })),
            [
                {
                    path: `/api/c/${f.id}/withdraw`,
                    body: { submissionId: Number(fourth) },
                },
            ],
        );
    },
);

for (const size of ["desktop", "mobile"] as const) {
    const viewport = VIEWPORTS[size];

    test(
        `${size}: two rows stay plain, three collapse with labelled ARIA, and returning to two clears pinning`,
        real,
        async () => {
            const f = await fixture();

            await open(f, viewport);
            await page.type({ selector: TEXTAREA }, "Threshold draft");
            await page.hover({ selector: '.topbar [aria-label="Files"]' });
            const before = await queued();
            const previous = await draft(f.id);
            const start = requests.length;
            const plain = await queueState();

            assert.equal(plain.toggle, false, "two rows have no disclosure bar");
            assert.equal(plain.hidden, false);
            assert.equal(plain.visible, true, "two rows remain visible without an extra tap");
            const third = await addQueued(f, "Third queued input");

            await until(async () => (await queued()).length === 3, "the third queued input");
            await queueExpanded(false);
            const collapsed = await queueState();

            assert.match(collapsed.label, /3\s+queued messages/i);
            assert.match(collapsed.label, /Show/i);
            assert.ok(
                collapsed.controls && collapsed.controlsInbox,
                "aria-controls names this inbox's ID",
            );
            assert.equal(
                await inPage<boolean>(
                    "return JSON.stringify(document.querySelector('.queue-toggle svg') !== null)",
                ),
                true,
                "the disclosure has a chevron",
            );
            await showQueue();
            assert.match((await queueState()).label, /Hide/i);
            await page.hover({ selector: '.topbar [aria-label="Files"]' });
            await queueExpanded(true);
            const withdrawn = await rest(f.id, "withdraw", { submissionId: Number(third) });

            assert.equal(withdrawn.status, 200);
            await until(
                async () => (await queued()).length === 2,
                "the queue returning to two inputs",
            );
            const reduced = await queueState();

            assert.equal(reduced.toggle, false);
            assert.equal(reduced.hidden, false);
            assert.equal(reduced.visible, true);
            assert.deepEqual(
                await queued(),
                before,
                "the original IDs, modes, order, and text stay intact",
            );
            await addQueued(f, "A new third queued input");
            await until(
                async () => (await queued()).length === 3,
                "the queue reaching three again",
            );
            await queueExpanded(false);
            assert.deepEqual(
                await draft(f.id),
                previous,
                "crossing the threshold preserves the original draft and selection",
            );
            assert.deepEqual(
                effectsSince(start).map(({ path, body }) => ({ path, body })),
                [
                    {
                        path: `/api/c/${f.id}/withdraw`,
                        body: { submissionId: Number(third) },
                    },
                ],
                "only the explicit fixture withdrawal sends a command",
            );
        },
    );

    test(
        `${size}: editing forces the queue open with an inert toggle even after pointer leave or outside taps`,
        real,
        async () => {
            const f = await fixture();
            const third = await addQueued(f, "Third queued input");

            await open(f, viewport, 3);
            await page.type({ selector: TEXTAREA }, "Draft kept while the queue is edited");
            await page.hover({ selector: '.topbar [aria-label="Files"]' });
            await queueExpanded(false);
            const before = await queued();
            const previous = await draft(f.id);
            const start = requests.length;

            await begin(2);
            await queueExpanded(true);
            assert.equal(
                (await queueState()).disabled,
                true,
                "editing disables the disclosure button",
            );
            await page.hover({ selector: '.topbar [aria-label="Files"]' });
            await queueExpanded(true);
            await page.click({ selector: TEXTAREA });
            await queueExpanded(true);
            await page.click({ selector: QUEUE_TOGGLE });
            await queueExpanded(true);
            await layout(viewport.width);
            await page.type({ selector: TEXTAREA }, "Edited without changing queue visibility");
            await page.click({ selector: SAVE });
            await restored(f.id, previous);
            await until(
                async () =>
                    (await queued())[2]?.editableText ===
                    "Edited without changing queue visibility",
                "the queued edit to commit",
            );
            assert.deepEqual(
                (await queued()).map(({ id, mode }) => ({ id, mode })),
                before.map(({ id, mode }) => ({ id, mode })),
            );
            await begin(2);
            await page.type({ selector: TEXTAREA }, "This edit is cancelled");
            await page.hover({ selector: '.topbar [aria-label="Files"]' });
            await queueExpanded(true);
            await layout(viewport.width);
            await page.click({ selector: CANCEL });
            await restored(f.id, previous);
            assert.equal(
                (await queued())[2]!.editableText,
                "Edited without changing queue visibility",
            );
            assert.deepEqual(
                effectsSince(start).map(({ path, body }) => ({ path, body })),
                [
                    {
                        path: `/api/c/${f.id}/edit-queued`,
                        body: {
                            submissionId: Number(third),
                            text: "Edited without changing queue visibility",
                            expectedText: "Third queued input",
                        },
                    },
                ],
            );
        },
    );

    test(`${size}: seven queued rows stay bounded, scroll, and remain editable`, real, async () => {
        const f = await fixture();

        for (let row = 3; row <= 7; row++) {
            await addQueued(f, `Queued input ${row}`, row % 2 === 0 ? "steer" : "followUp");
        }

        await open(f, viewport, 7);
        await page.type({ selector: TEXTAREA }, "Draft beside a long queue");
        const previous = await draft(f.id);
        const before = await queued();
        const start = requests.length;

        await inboxLayout(viewport, 7, true);
        await page.evaluate(`
            const inbox = document.querySelector('.inbox');

            inbox.scrollTop = inbox.scrollHeight;
        `);
        assert.ok(
            (await inPage<number>(
                "return JSON.stringify(document.querySelector('.inbox').scrollTop)",
            )) > 0,
            "the last queue row is reachable by scrolling",
        );
        await begin(6);
        assert.equal(await value(), "Queued input 7");
        await layout(viewport.width);
        await inboxLayout(viewport, 7, true);
        await shot(`queued-edit-large-queue-${size}`);
        await page.type({ selector: TEXTAREA }, "Saved seventh queued input");
        await page.click({ selector: SAVE });
        await restored(f.id, previous);
        await until(
            async () => (await queued())[6]?.editableText === "Saved seventh queued input",
            "the seventh queued edit",
        );
        assert.deepEqual(
            (await queued()).map(({ id, mode }) => ({ id, mode })),
            before.map(({ id, mode }) => ({ id, mode })),
            "editing the last row keeps the whole queue in order",
        );

        await begin();
        await page.type({ selector: TEXTAREA }, "Cancelled change in the first row");
        await layout(viewport.width);
        await page.click({ selector: CANCEL });
        await restored(f.id, previous);
        assert.equal(
            (await queued())[0]!.editableText,
            FULL_TEXT,
            "the first row remains unchanged after cancel",
        );
        assert.equal(
            effectsSince(start).length,
            1,
            "scrolling and cancelling never submit extra commands",
        );
    });

    test(
        `${size}: an unbroken long author is ellipsized without clipping queue modes or controls`,
        real,
        async () => {
            const f = await fixture();
            const name = `Author${"X".repeat(54)}`;
            const author = app.config.addUser(name, "guest").user;
            const text = "A queued message from the long unbroken author";
            const submissionId = await addQueued(f, text, "steer", author);

            await open(f, viewport, 3);
            await page.type({ selector: TEXTAREA }, "Long-author draft");
            const previous = await draft(f.id);
            const start = requests.length;

            await inboxLayout(viewport, 3);
            const measured = await inPage<{
                text: string;
                clipped: boolean;
                ellipsis: string;
                whiteSpace: string;
            }>(`
            const author = document.querySelector('.queued:nth-child(3) .queued-mode .muted');
            const style = getComputedStyle(author);

            return JSON.stringify({
                text: author.textContent,
                clipped: author.scrollWidth > author.clientWidth,
                ellipsis: style.textOverflow,
                whiteSpace: style.whiteSpace,
            });
        `);

            assert.ok(measured.text.includes(name), "the full author name remains in the DOM");
            assert.equal(
                measured.clipped,
                true,
                "the author gives space back to the mode and preview",
            );
            assert.equal(measured.ellipsis, "ellipsis");
            assert.equal(measured.whiteSpace, "nowrap");
            await begin(2);
            assert.equal(
                await value(),
                text,
                "the editable text excludes even a maximum-length author prefix",
            );
            await layout(viewport.width);
            await page.type({ selector: TEXTAREA }, "Saved text from the long author");
            await page.click({ selector: SAVE });
            await restored(f.id, previous);
            await until(
                async () => (await queued())[2]?.editableText === "Saved text from the long author",
                "the long-author queued edit",
            );
            assert.equal((await queued())[2]!.id, Number(submissionId));
            assert.equal((await queued())[2]!.mode, "steer");
            assert.match(
                (await queued())[2]!.text,
                new RegExp(`^\\[from: ${name}\\] `),
                "editing keeps the author prefix",
            );
            await begin(2);
            await layout(viewport.width);
            await shot(`queued-edit-long-author-${size}`);
            await page.type({ selector: TEXTAREA }, "Cancelled long-author change");
            await page.click({ selector: CANCEL });
            await restored(f.id, previous);
            assert.equal((await queued())[2]!.editableText, "Saved text from the long author");
            assert.equal(effectsSince(start).length, 1);
        },
    );

    test(
        `${size}: a long queued edit scrolls its text while Save and Cancel remain fully visible`,
        real,
        async () => {
            const f = await fixture();
            const text = Array.from(
                { length: 100 },
                (_, index) => `Queued line ${index + 1}: ${"unbroken-content".repeat(8)}`,
            ).join("\n");
            const submissionId = await addQueued(f, text);

            await open(f, viewport, 3);
            await page.type({ selector: TEXTAREA }, "Draft below a long queued edit");
            const previous = await draft(f.id);
            const start = requests.length;

            await begin(2);
            assert.equal(
                await value(),
                text,
                "all one hundred lines are editable, not just the preview",
            );
            await layout(viewport.width);
            await inboxLayout(viewport, 3);
            const measured = await inPage<{
                height: number;
                viewportHeight: number;
                scrollHeight: number;
                clientHeight: number;
                overflowY: string;
            }>(`
            const textarea = document.querySelector(${JSON.stringify(TEXTAREA)});

            return JSON.stringify({
                height: textarea.getBoundingClientRect().height,
                viewportHeight: innerHeight,
                scrollHeight: textarea.scrollHeight,
                clientHeight: textarea.clientHeight,
                overflowY: getComputedStyle(textarea).overflowY,
            });
        `);

            assert.ok(
                measured.height <= measured.viewportHeight * 0.4 + 1,
                "the long editor does not push its controls off screen",
            );
            assert.ok(
                measured.scrollHeight > measured.clientHeight,
                "the complete edit text scrolls within the textarea",
            );
            assert.ok(["auto", "scroll"].includes(measured.overflowY));
            await shot(`queued-edit-long-text-${size}`);
            const edited = `${text}\nSaved final line`;

            await page.type(undefined, "\nSaved final line", { append: true });
            assert.equal(await value(), edited);
            await layout(viewport.width);
            await page.press("Enter");
            await restored(f.id, previous);
            await until(
                async () => (await queued())[2]?.editableText === edited,
                "the full long queued edit",
            );
            assert.equal((await queued())[2]!.id, Number(submissionId));
            await begin(2);
            await page.type(undefined, "\nCancelled final line", { append: true });
            await layout(viewport.width);
            await page.click({ selector: CANCEL });
            await restored(f.id, previous);
            assert.equal(
                (await queued())[2]!.editableText,
                edited,
                "cancelling a long edit leaves the committed text intact",
            );
            assert.equal(effectsSince(start).length, 1);
        },
    );
}
