// Real Chromium owns the browser-to-disk contract: toolbar admission, CodeMirror input, Save/Cancel,
// draft lifetime and phone layout. HTTP/file and LSP tests cannot catch a disconnected editor UI.
// No editor globals, test-only exports, mocked requests, or live user data.
import {
    type App,
    cleanUp,
    newSession,
    openApp,
    root,
    scriptedModel,
    until,
    work,
} from "./helpers.ts";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { createServer, type Server } from "node:http";
import { join } from "node:path";
import { after, before, test } from "node:test";
import type { ConversationId } from "@earendil-works/pi-durable";
import { Browsers } from "../src/server/browser.ts";
import { findBrowser } from "../src/server/browser/discovery.ts";
import type { BrowserPage } from "../src/server/browser/page.ts";
import { VIEWPORTS, type Viewport } from "../src/server/browser/viewport.ts";
import { createHandler } from "../src/server/http.ts";

const chromium = findBrowser();
const real = {
    skip: chromium === undefined ? "no Chromium-based browser on this machine" : false,
} as const;
const EDITOR = '[aria-label="File editor"]';
const SAVE_STATE = '.file-edit-statusbar [role="status"]';
const LSP_MENU_BUTTON = '[aria-label="Language server status"]';

type Fixture = { id: ConversationId; path: string; disk: string };

let app: App;
let server: Server;
let browsers: Browsers;
let page: BrowserPage;
let base = "";
const lspRequests: { path: string; action?: string }[] = [];
// A controllable network boundary delays the genuine handler, never fabricates a save response.
let slowSave: { endpoint: string; entered: boolean; resume: Promise<void> } | undefined;

async function inPage<T>(script: string): Promise<T> {
    return JSON.parse(await page.evaluate(script)) as T;
}

const visible = (selector: string) =>
    inPage<boolean>(`
        const element = document.querySelector(${JSON.stringify(selector)});

        return JSON.stringify(!!element && element.getClientRects().length > 0 && getComputedStyle(element).visibility !== 'hidden');
    `);
const text = (selector: string) =>
    inPage<string>(
        `return JSON.stringify(document.querySelector(${JSON.stringify(selector)})?.textContent ?? '')`,
    );
const title = (selector: string) =>
    inPage<string>(
        `return JSON.stringify(document.querySelector(${JSON.stringify(selector)})?.getAttribute('title') ?? '')`,
    );
const editorText = () =>
    inPage<string>(`
        const { EditorView } = await import('/vendor/editor.mjs');
        const view = EditorView.findFromDOM(document.querySelector(${JSON.stringify(EDITOR)}));

        return JSON.stringify(view.state.sliceDoc());
    `);
const hasButton = (label: string, enabled = false) =>
    inPage<boolean>(`
        return JSON.stringify([...document.querySelectorAll('.file-viewer button')].some(button =>
            (button.getAttribute('aria-label') || button.textContent.trim()) === ${JSON.stringify(label)} && button.getClientRects().length > 0 &&
            (${JSON.stringify(!enabled)} || !button.disabled)));
    `);

async function fixture(original: string, path = "notes.txt"): Promise<Fixture> {
    const directory = mkdtempSync(join(work, "file-editor-"));
    const disk = join(directory, path);

    mkdirSync(join(disk, ".."), { recursive: true });
    writeFileSync(disk, original);

    return { id: await newSession(app, directory), path, disk };
}

async function open(
    f: Fixture,
    viewport: Viewport = VIEWPORTS.desktop,
    surface: "sheet" | "panel" = "sheet",
): Promise<void> {
    await page.setViewport(viewport);
    await page.navigate(`${base}/s/${f.id}`);
    await until(
        async () =>
            await inPage<boolean>(`
                const { store } = await import('/store.js');

                return JSON.stringify(store.state.conversationId === ${Number(f.id)} && !!store.state.view && document.documentElement.dataset.route === undefined);
            `),
        "the isolated conversation",
        20_000,
    );

    if (surface === "panel") {
        await page.evaluate(`(await import('/files-panel.js')).setFilesOpen(true, 'files')`);
    }

    await openFile(f);
}

async function openFile(f: Fixture): Promise<void> {
    await page.evaluate(`(await import('/ui.js')).openFile(${JSON.stringify(f.path)})`);

    try {
        await until(() => hasButton("Edit", true), "the file viewer's Edit button", 20_000);
        await until(
            () =>
                inPage<boolean>(`
                const container = document.querySelector('.sheet') ?? document.querySelector('.files-tile');

                return JSON.stringify(!!container && container.getAnimations().every(animation => animation.playState !== 'running'));
            `),
            "the viewer to finish moving before a real tap",
        );
    } catch (error) {
        assert.fail(`${String(error)}; viewer: ${await text(".file-viewer")}`);
    }
}

async function begin(): Promise<void> {
    await page.click({ label: "Edit" });

    try {
        await until(() => visible(EDITOR), "the real CodeMirror editor", 20_000);
    } catch (error) {
        assert.fail(`${String(error)}; viewer: ${await text(".file-viewer")}`);
    }
}

/** Use CodeMirror's public DOM lookup and transaction API, never an application test hook. */
async function replace(text: string): Promise<void> {
    await page.evaluate(`
        const { EditorView } = await import('/vendor/editor.mjs');
        const view = EditorView.findFromDOM(document.querySelector(${JSON.stringify(EDITOR)}));

        view.dispatch({ changes: { from: 0, to: view.state.doc.length, insert: ${JSON.stringify(text)} } });
        view.dispatch({ selection: { anchor: view.state.doc.length }, scrollIntoView: true });
        view.focus();
    `);
    await until(() => hasButton("Save", true), "the dirty editor's enabled Save button");
}

async function saved(f: Fixture, expected: string): Promise<void> {
    await until(
        () => readFileSync(f.disk, "utf8") === expected,
        "the edit persisted on disk",
        20_000,
    );
    await until(async () => (await text(SAVE_STATE)) === "Saved", "the saved editor's clean state");
    assert.deepEqual(readFileSync(f.disk), Buffer.from(expected), "exact saved UTF-8 bytes");
    assert.equal(await editorText(), expected, "the live editor agrees with disk");
}

type Rect = {
    left: number;
    right: number;
    top: number;
    bottom: number;
    width: number;
    height: number;
};
type Layout = {
    width: number;
    height: number;
    pageWidth: number;
    root: Rect;
    edit: Rect;
    editor: Rect;
    footer: Rect;
    status: Rect;
    scrollHeight: number;
    clientHeight: number;
    topCommands: number;
    buttons: { label: string; rect: Rect; hit: boolean; shortcut: string }[];
    serverButton: { rect: Rect; hit: boolean };
};

/** The outer viewer must not scroll away its footer; only source text scrolls inside CodeMirror. */
async function layout(surface: "sheet" | "panel", mobile = false): Promise<Layout> {
    await until(() => visible(".file-edit-footer"), "the compact editor footer");
    const measured = await inPage<Layout>(`
        await new Promise(requestAnimationFrame);
        const root = document.querySelector(${JSON.stringify(surface === "sheet" ? ".sheet-body" : ".ft-view")});
        const rect = element => {
            const r = element.getBoundingClientRect();

            return { left: r.left, right: r.right, top: r.top, bottom: r.bottom, width: r.width, height: r.height };
        };
        const buttons = [...document.querySelectorAll('.file-edit-shortcuts button')].map(button => {
            const r = rect(button);
            const hit = document.elementFromPoint(r.left + r.width / 2, r.top + r.height / 2);

            return { label: button.getAttribute('aria-label'), rect: r, hit: hit === button || button.contains(hit), shortcut: button.querySelector('kbd')?.textContent ?? '' };
        });

        const server = document.querySelector(${JSON.stringify(LSP_MENU_BUTTON)});
        const serverRect = rect(server);
        const serverHit = document.elementFromPoint(serverRect.left + serverRect.width / 2, serverRect.top + serverRect.height / 2);

        return JSON.stringify({
            width: innerWidth,
            height: innerHeight,
            pageWidth: Math.max(document.documentElement.scrollWidth, document.body.scrollWidth),
            root: rect(root),
            edit: rect(document.querySelector('.file-edit')),
            editor: rect(document.querySelector('.file-edit-surface')),
            footer: rect(document.querySelector('.file-edit-footer')),
            status: rect(document.querySelector('.file-edit-statusbar')),
            scrollHeight: root.scrollHeight,
            clientHeight: root.clientHeight,
            topCommands: [...document.querySelectorAll('.file-tools button')].filter(button => ['Save', 'Cancel', 'Format', 'Suggestions'].includes(button.getAttribute('aria-label') || button.textContent.trim())).length,
            buttons,
            serverButton: { rect: serverRect, hit: serverHit === server || server.contains(serverHit) },
        });
    `);
    const fits = (r: Rect) =>
        r.left >= -1 &&
        r.right <= measured.width + 1 &&
        r.top >= -1 &&
        r.bottom <= measured.height + 1;

    assert.equal(
        measured.width,
        page.viewport.width,
        "the viewport is not widened by source lines",
    );
    assert.ok(
        measured.pageWidth <= measured.width,
        `no horizontal page overflow: ${JSON.stringify(measured)}`,
    );
    assert.ok(
        measured.root.bottom - measured.edit.bottom <= 32,
        `editor fills available height: ${JSON.stringify(measured)}`,
    );
    assert.ok(
        measured.editor.height >= measured.footer.top - measured.editor.top - 24,
        "source fills the space above the footer",
    );
    assert.ok(
        measured.scrollHeight <= measured.clientHeight + 1,
        "the outer viewer does not clip or scroll away the footer",
    );
    assert.ok(
        fits(measured.editor) && fits(measured.footer) && fits(measured.status),
        "source, status chip and footer stay on screen",
    );
    assert.ok(
        measured.footer.top >= measured.editor.bottom - 1,
        "controls sit below the source, not above or over it",
    );
    assert.equal(measured.topCommands, 0, "editing commands are no longer in a top toolbar");
    assert.deepEqual(measured.buttons.map(({ label }) => label).sort(), [
        "Cancel",
        "Format",
        "Save",
        "Suggestions",
    ]);

    assert.ok(
        fits(measured.serverButton.rect) && measured.serverButton.hit,
        "the language-server chip stays visible and reachable",
    );

    if (mobile) {
        assert.ok(
            measured.serverButton.rect.width >= 40 && measured.serverButton.rect.height >= 40,
            "the language-server chip is touch-sized",
        );
    }

    for (const button of measured.buttons) {
        assert.ok(fits(button.rect), `${button.label} fits on screen`);
        assert.ok(button.hit, `${button.label} is reachable, not covered`);

        if (mobile) {
            assert.ok(
                button.rect.width >= 40 && button.rect.height >= 40,
                `${button.label} is touch-sized`,
            );
        } else {
            assert.ok(
                button.shortcut.trim().length > 0,
                `${button.label} displays its keyboard shortcut`,
            );
        }
    }

    return measured;
}

async function cancel(): Promise<void> {
    await page.click({ label: "Cancel" });
    await until(async () => !(await visible(EDITOR)), "Cancel to return to the viewer");
    await until(() => hasButton("Edit", true), "the viewer after Cancel");
}

before(async () => {
    if (chromium === undefined) {
        return;
    }

    app = await openApp(scriptedModel());
    const handler = createHandler({
        app,
        listen: { host: "127.0.0.1", port: 0 },
        restart: () => {},
    });

    server = createServer((request, response) => {
        if (request.method === "POST" && /\/api\/c\/\d+\/lsp$/.test(request.url ?? "")) {
            const observed: { path: string; action?: string } = { path: request.url! };
            const chunks: Buffer[] = [];

            lspRequests.push(observed);
            request.on("data", (chunk: Buffer) => chunks.push(chunk));
            request.on("end", () => {
                observed.action = JSON.parse(Buffer.concat(chunks).toString()).action;
            });
        }

        const gate = slowSave;

        if (request.method === "POST" && gate !== undefined && request.url === gate.endpoint) {
            gate.entered = true;
            void gate.resume.then(() => handler(request, response));
        } else {
            void handler(request, response);
        }
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    base = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
    browsers = new Browsers({
        dataDir: mkdtempSync(join(root, "file-editor-ui-")),
        load: async () => undefined,
        save: () => {},
    });
    page = await browsers.open(1);
    await page.setViewport(VIEWPORTS.desktop);
    await page.navigate(`${base}/login?token=${encodeURIComponent(app.config.ownerToken)}`);
});

after(async () => {
    await browsers?.closeAll({ final: true });
    server?.closeAllConnections();
    server?.close();
    await app?.close();
    cleanUp();
});

test(
    "real editor Cancel discards edits; Save persists keyboard input and advances the revision",
    real,
    async () => {
        const original = "First line.\nLast line.\n";
        const f = await fixture(original);

        await open({ ...f, path: `${f.path}:2` });
        await begin();
        assert.equal(await editorText(), original);
        assert.equal(
            await inPage<number>(`
                const { EditorView } = await import('/vendor/editor.mjs');
                const view = EditorView.findFromDOM(document.querySelector(${JSON.stringify(EDITOR)}));

                return JSON.stringify(view.state.doc.lineAt(view.state.selection.main.head).number);
            `),
            2,
            "Edit starts at the source line named by the file link",
        );
        await replace("Discard this edit.\n");
        assert.equal(await text(SAVE_STATE), "Modified");
        assert.equal(readFileSync(f.disk, "utf8"), original, "typing never writes through to disk");
        await page.press("Escape");
        await until(
            () => hasButton("Edit", true),
            "Escape to cancel editing without closing the viewer",
        );
        assert.equal(await visible(EDITOR), false);
        assert.equal(readFileSync(f.disk, "utf8"), original, "Cancel does not persist changes");
        await begin();
        assert.equal(await editorText(), original, "Cancel removed the unsaved draft");
        await replace("First line edited.\nLast line.\n");
        await page.type(undefined, "Added with real keyboard input.\n", { append: true });
        const firstSave = "First line edited.\nLast line.\nAdded with real keyboard input.\n";

        assert.equal(await editorText(), firstSave);
        await page.click({ label: "Save" });
        await saved(f, firstSave);
        await replace("Second save uses the new revision.\n");
        await page.click({ label: "Save" });
        await saved(f, "Second save uses the new revision.\n");
        await cancel();
        await open(f);
        await begin();
        assert.equal(
            await editorText(),
            "Second save uses the new revision.\n",
            "reopening reads the saved file",
        );
        await cancel();
    },
);

// A late response must not revive the old viewer or overwrite the file opened after Back.
test("a Save finishing after Back leaves the newly opened file alone", real, async () => {
    const f = await fixture("Original first file.\n");
    const other: Fixture = { id: f.id, path: "other.txt", disk: join(f.disk, "..", "other.txt") };
    const otherText = "The second file must not change.\n";

    let release = () => {};

    writeFileSync(other.disk, otherText);
    await open(f, VIEWPORTS.mobile);
    await begin();
    await replace("Save admitted before leaving.\n");
    slowSave = {
        endpoint: `/api/c/${f.id}/edit`,
        entered: false,
        resume: new Promise<void>((resolve) => {
            release = resolve;
        }),
    };

    try {
        await page.click({ label: "Save" });
        await until(
            () => slowSave?.entered === true,
            "the genuine Save request at the network boundary",
        );
        assert.equal(await text(SAVE_STATE), "Saving…");
        assert.equal(
            await hasButton("Save", true),
            false,
            "Save is disabled while its request is pending",
        );
        await page.evaluate("history.back()");
        await until(async () => !(await visible(EDITOR)), "the old editor to unmount after Back");
        await openFile(other);
        await begin();
        assert.equal(await editorText(), otherText);
        release();
        await until(
            () => readFileSync(f.disk, "utf8") === "Save admitted before leaving.\n",
            "the late Save to persist",
        );
        await until(
            async () => /File saved/.test(await text(".notices")),
            "the late Save completion notice",
        );
        assert.equal(await editorText(), otherText, "late completion leaves the new editor alone");
        assert.equal(readFileSync(other.disk, "utf8"), otherText);
        await cancel();
        assert.equal(
            await text(".file-tools .file-path").then((value) => value.startsWith("other.txt")),
            true,
            "the current viewer still belongs to the second file",
        );
    } finally {
        release();
        slowSave = undefined;
    }
});

// Editing an existing line and using Enter must not normalize line endings or strip the UTF-8 BOM.
test("browser typing and Save preserve CRLF, UTF-8 BOM and non-ASCII text", real, async () => {
    const original = "\uFEFFFirst café.\r\nSecond line.\r\n";
    const f = await fixture(original);

    await open(f);
    await begin();
    assert.equal(await editorText(), original, "opening retains BOM and CRLF");
    await page.evaluate(`
        const { EditorView } = await import('/vendor/editor.mjs');
        const view = EditorView.findFromDOM(document.querySelector(${JSON.stringify(EDITOR)}));
        const line = view.state.doc.line(2);

        view.dispatch({ selection: { anchor: line.from, head: line.to } });
        view.focus();
    `);
    await page.type(undefined, "Second line edited ✅.", { append: true });
    await page.press("Enter");
    await page.type(undefined, "A new line.", { append: true });
    const expected = "\uFEFFFirst café.\r\nSecond line edited ✅.\r\nA new line.\r\n";

    assert.equal(await editorText(), expected, "Enter uses the file's original separator");
    await until(() => hasButton("Save", true), "Save after keyboard input");
    await page.click({ label: "Save" });
    await saved(f, expected);
    await cancel();
});

// A real outside writer changes the file after the editor loads, not a stubbed 409 response.
test(
    "external file changes reject Save visibly and keep the unsaved editor usable",
    real,
    async () => {
        const f = await fixture("Original on disk.\n");
        const outside = "Changed by another writer.\n";
        const unsaved = "My unsaved edit must survive.\n";

        await open(f);
        await begin();
        await replace(unsaved);
        writeFileSync(f.disk, outside);
        await page.click({ label: "Save" });
        await until(
            () => visible('.file-edit [role="alert"]'),
            "the visible save conflict",
            20_000,
        );
        assert.match(await text('.file-edit [role="alert"]'), /changed|conflict|modified/i);
        assert.equal(
            await text(SAVE_STATE),
            "Save failed",
            "the footer exposes the failed save state",
        );
        assert.equal(await editorText(), unsaved, "failed Save retains all editor text");
        assert.equal(readFileSync(f.disk, "utf8"), outside, "the outside edit was not overwritten");
        await until(() => hasButton("Save", true), "Save to be usable after the conflict");
        await replace("Still editable after the rejected save.\n");
        assert.equal(await editorText(), "Still editable after the rejected save.\n");
        await cancel();
        assert.equal(
            readFileSync(f.disk, "utf8"),
            outside,
            "Cancel after failure leaves disk alone",
        );
    },
);

// A remount alone could pass with in-memory state. Reload after Back proves tab-persisted drafts.
test(
    "Back and a page reload keep an unsaved draft for reopening; Save clears it",
    real,
    async () => {
        const original = "Unchanged until an explicit Save.\n";
        const draft = "Draft restored after leaving the file.\n";
        const f = await fixture(original);

        await open(f, VIEWPORTS.mobile);
        await begin();
        await replace(draft);
        await until(
            async () =>
                await inPage<boolean>(
                    "return JSON.stringify((history.state?.pocket?.layers ?? 0) > 0)",
                ),
            "the file sheet's Back entry",
        );
        await page.evaluate("history.back()");
        await until(
            async () =>
                await inPage<boolean>(`
                const { store } = await import('/store.js');

                return JSON.stringify(store.state.sheet === null && !document.querySelector(${JSON.stringify(EDITOR)}));
            `),
            "Back to close the editor sheet",
        );
        assert.equal(readFileSync(f.disk, "utf8"), original, "Back does not save");
        await page.reload();
        await until(() => visible(".composer textarea"), "the conversation after reload", 20_000);
        await openFile(f);
        await begin();
        await until(async () => (await editorText()) === draft, "the restored session draft");
        assert.match(await title(SAVE_STATE), /Recovered unsaved draft/i);
        assert.equal(await text(SAVE_STATE), "Modified");
        assert.equal(readFileSync(f.disk, "utf8"), original, "reopening does not save either");
        await page.click({ label: "Save" });
        await saved(f, draft);
        await cancel();
        await begin();
        assert.equal(await editorText(), draft, "reopening shows the saved text");
        assert.doesNotMatch(await title(SAVE_STATE), /Recovered unsaved draft/i);
        assert.equal(await hasButton("Save", true), false, "the saved draft is no longer dirty");
        await cancel();
    },
);

// Long source lines may scroll inside CodeMirror, but must not widen the phone or hide its footer.
test(
    "mobile full-height sheet keeps its compact touch footer reachable even with long lines",
    real,
    async () => {
        const f = await fixture(
            "A phone-sized editor.\n",
            "nested/a-long-file-name-to-edit-on-a-phone.txt",
        );
        const long = `Phone edit ${"unbreakable".repeat(100)}\n`;

        await open(f, VIEWPORTS.mobile);
        await begin();
        await replace(long);
        await layout("sheet", true);
        await page.setViewport({ ...VIEWPORTS.mobile, height: 620 });
        await layout("sheet", true);
        assert.equal(await editorText(), long, "a shorter viewport keeps the live edit");

        await page.click({ label: "Save" });
        await saved(f, long);
        await cancel();
    },
);

// A short fixed-height editor wastes the Files panel; resizing must flow into the same live buffer.
test(
    "Files panel editor fills available height and resizes without losing its buffer",
    real,
    async () => {
        const original = "Panel editor.\n";
        const draft = "This live buffer survives growing and shrinking the panel.\n";
        const f = await fixture(original);

        await open(f, VIEWPORTS.desktop, "panel");
        await begin();

        try {
            await replace(draft);
            const initial = await layout("panel");

            await page.setViewport({ ...VIEWPORTS.desktop, height: 1100 });
            const taller = await layout("panel");

            assert.ok(
                taller.editor.height >= initial.editor.height + 250,
                "available panel height grows the editor, not empty space",
            );
            await page.setViewport({ ...VIEWPORTS.desktop, height: 650 });
            await layout("panel");
            assert.equal(await editorText(), draft, "resizing keeps the same live buffer");
            assert.equal(readFileSync(f.disk, "utf8"), original, "resizing never saves");
            await cancel();
        } finally {
            await page.evaluate(`(await import('/files-panel.js')).setFilesOpen(false)`);
        }
    },
);

// This guards browser role gating, not the separate backend authorization/protocol matrix.
test("a guest can edit locally but never starts owner-only language support", real, async () => {
    const f = await fixture("export const answer = 42;\n", "guest.ts");
    const guest = app.config.addUser("File editor guest", "guest");

    const ownerPage = page;

    page = await browsers.open(2);

    try {
        await page.navigate(`${base}/login?token=${encodeURIComponent(guest.token)}`);
        const start = lspRequests.length;

        await open(f);
        await begin();
        await until(
            () => visible(".file-edit-lsp-local"),
            "the guest's local-only language status",
        );
        assert.equal(
            await visible(LSP_MENU_BUTTON),
            false,
            "guests cannot inspect owner language servers",
        );
        assert.match(await text(".file-edit-lsp-local"), /Local editing/i);
        assert.match(await title(".file-edit-lsp-local"), /owner-only/i);
        await replace("export const answer = 43;\n");
        await page.click({ label: "Save" });
        await saved(f, "export const answer = 43;\n");
        assert.deepEqual(
            lspRequests.slice(start).filter(({ path }) => path === `/api/c/${f.id}/lsp`),
            [],
            "the guest editor sends no LSP traffic",
        );
        await cancel();
    } finally {
        await browsers.close(2);
        page = ownerPage;
    }
});

// The imported object's property is absent from this file, so lexical/local completion cannot prove this.
test(
    "native TS7 diagnostics, status menu, completion and format/save shortcuts work in the editor",
    real,
    async () => {
        const original =
            "import { payload } from './dependency';\nconst invalid: number = 'wrong';\npayload;\n";
        const f = await fixture(original, "main.ts");
        const directory = join(f.disk, "..");

        writeFileSync(
            join(directory, "dependency.ts"),
            "export const payload = { nativeOnlyCompletion: 42 };\n",
        );
        writeFileSync(
            join(directory, "tsconfig.json"),
            JSON.stringify({
                compilerOptions: {
                    strict: true,
                    noEmit: true,
                    target: "ES2022",
                    module: "ESNext",
                    moduleResolution: "Bundler",
                },
            }),
        );
        const start = lspRequests.length;

        await open(f);
        assert.deepEqual(
            lspRequests.slice(start).filter(({ path }) => path === `/api/c/${f.id}/lsp`),
            [],
            "viewing TypeScript does not start a language server",
        );
        await begin();

        try {
            await until(
                () => visible(".cm-lintRange-error"),
                "a native TypeScript diagnostic decoration",
                30_000,
            );
            await page.hover({ selector: ".cm-lintRange-error" });
            await until(() => visible(".cm-diagnosticText"), "the diagnostic tooltip");
            assert.match(
                await text(".cm-diagnosticText"),
                /Type 'string' is not assignable to type 'number'/,
            );
            const endpoint = `/api/c/${f.id}/lsp`;
            const opensBefore = lspRequests.filter(
                ({ path, action }) => path === endpoint && action === "open",
            ).length;

            for (const closing of ["Escape", "outside", "Back"]) {
                const layers = await inPage<number>(
                    "return JSON.stringify(history.state?.pocket?.layers ?? 0)",
                );

                // Move deliberately between menu interactions, past the app's rapid-tap guard.
                await page.hover({ selector: LSP_MENU_BUTTON });
                await page.click({ selector: LSP_MENU_BUTTON });
                await until(
                    () => visible('.file-lsp-menu[role="dialog"]'),
                    "the owner language-server menu",
                );
                await until(
                    async () =>
                        /TypeScript\s*7 native/i.test(await text(".file-lsp-menu")) &&
                        /running/i.test(await text(".file-lsp-menu")),
                    "the active named native server and running state",
                );
                assert.match(await text(".file-lsp-menu"), /Language servers/);

                if (closing === "Back") {
                    await until(
                        async () =>
                            (await inPage<number>(
                                "return JSON.stringify(history.state?.pocket?.layers ?? 0)",
                            )) > layers,
                        "the status menu Back entry",
                    );
                    await page.evaluate("history.back()");
                } else if (closing === "outside") {
                    await page.hover({ selector: ".file-tools .file-path" });
                    await page.click({ selector: ".file-tools .file-path" });
                } else {
                    await page.press("Escape");
                }

                await until(
                    async () => !(await visible(".file-lsp-menu")),
                    `${closing} to dismiss only the server menu`,
                );
                assert.equal(await visible(EDITOR), true, `${closing} keeps the editor open`);
                assert.equal(await editorText(), original, `${closing} leaves the buffer alone`);
            }

            assert.equal(
                lspRequests.filter(({ path, action }) => path === endpoint && action === "open")
                    .length,
                opensBefore,
                "listing server status does not reopen or start language support",
            );
            assert.ok(
                lspRequests.some(({ path, action }) => path === endpoint && action === "status"),
                "the menu obtains a real HTTP status snapshot",
            );
            await replace("import { payload } from './dependency';\npayload.\n");
            await page.evaluate(`
            const { EditorView } = await import('/vendor/editor.mjs');
            const view = EditorView.findFromDOM(document.querySelector(${JSON.stringify(EDITOR)}));

            view.dispatch({ selection: { anchor: view.state.doc.line(2).to } });
            view.focus();
        `);
            // Background a dirty editor with its status menu open. Transport polling and the
            // transient menu must stop; real native completion below must work on the same view
            // after a fresh lease attaches the current unsaved document.
            await page.hover({ selector: LSP_MENU_BUTTON });
            await page.click({ selector: LSP_MENU_BUTTON });
            await until(
                () => visible('.file-lsp-menu[role="dialog"]'),
                "status menu before suspension",
            );
            await page.evaluate(`
                const { EditorView } = await import('/vendor/editor.mjs');
                window.editorBeforeBackground = EditorView.findFromDOM(document.querySelector(${JSON.stringify(EDITOR)}));
                window.editorSelectionBeforeBackground = window.editorBeforeBackground.state.selection.main.anchor;
                Object.defineProperty(document, 'visibilityState', { configurable: true, value: 'hidden' });
                document.dispatchEvent(new Event('visibilitychange'));
            `);

            try {
                await until(() => !visible(".file-lsp-menu"), "backgrounding closes status menu");
                await until(() => hasButton("Format", false), "backgrounding disables formatting");
                await page.evaluate("await new Promise(resolve => setTimeout(resolve, 800))");
                const suspended = lspRequests.filter(({ path }) => path === endpoint).length;

                await page.evaluate("await new Promise(resolve => setTimeout(resolve, 2300))");
                assert.equal(
                    lspRequests.filter(({ path }) => path === endpoint).length,
                    suspended,
                    "hidden editor/status menu sends no LSP requests",
                );
                await page.evaluate(`
                    delete document.visibilityState;
                    document.dispatchEvent(new Event('visibilitychange'));
                `);
                await until(
                    () => hasButton("Format", true),
                    "fresh native language support after resume",
                    30_000,
                );
                assert.equal(
                    await inPage<boolean>(`const { EditorView } = await import('/vendor/editor.mjs');
                        const view = EditorView.findFromDOM(document.querySelector(${JSON.stringify(EDITOR)}));
                        return JSON.stringify(view === window.editorBeforeBackground
                            && view.state.selection.main.anchor === window.editorSelectionBeforeBackground);`),
                    true,
                    "resume preserves EditorView, cursor and undo history instead of rebuilding",
                );
                assert.equal(
                    await editorText(),
                    "import { payload } from './dependency';\npayload.\n",
                );
                const undoModifier = await inPage<string>(
                    "return JSON.stringify(/Mac|iPhone|iPad/.test(navigator.platform) ? 'Meta' : 'Control')",
                );

                await page.evaluate("window.editorBeforeBackground.focus()");
                await page.press(`${undoModifier}+z`);
                await until(
                    async () => (await editorText()) === original,
                    "pre-background undo history",
                );
                await page.press(`${undoModifier}+Shift+z`);
                await until(
                    async () =>
                        (await editorText()) ===
                        "import { payload } from './dependency';\npayload.\n",
                    "redo after resuming language support",
                );
                await page.evaluate(`
                    const view = window.editorBeforeBackground;
                    view.dispatch({ selection: { anchor: view.state.doc.line(2).to } });
                `);
                assert.equal(
                    readFileSync(f.disk, "utf8"),
                    original,
                    "backgrounding never saves the dirty buffer",
                );
            } finally {
                await page.evaluate(`
                    delete document.visibilityState;
                    document.dispatchEvent(new Event('visibilitychange'));
                    delete window.editorBeforeBackground;
                    delete window.editorSelectionBeforeBackground;
                `);
            }

            await page.hover({ selector: EDITOR });
            await page.hover({ label: "Suggestions" });
            await page.click({ label: "Suggestions" });
            await until(
                async () => /nativeOnlyCompletion/.test(await text(".cm-tooltip-autocomplete")),
                "clicking the footer suggestion control",
            );
            await page.press("Escape");
            await until(
                async () => !(await visible(".cm-tooltip-autocomplete")),
                "Escape to dismiss suggestions",
            );
            assert.equal(
                await visible(EDITOR),
                true,
                "Escape from suggestions does not cancel the edit",
            );
            await page.press("Control+Space");
            await until(
                async () => /nativeOnlyCompletion/.test(await text(".cm-tooltip-autocomplete")),
                "the native cross-file completion suggestion",
                30_000,
            );
            // Hovering the real selected option also lets CM's short interaction guard expire.
            await page.hover({ selector: '.cm-tooltip-autocomplete [aria-selected="true"]' });
            assert.match(
                await text('.cm-tooltip-autocomplete [aria-selected="true"]'),
                /nativeOnlyCompletion/,
            );
            await page.press("Enter");
            await until(
                async () => (await editorText()).includes("payload.nativeOnlyCompletion"),
                "accepting the native completion",
            );
            assert.equal(
                readFileSync(f.disk, "utf8"),
                original,
                "diagnostics and completions never save implicitly",
            );
            const unformatted =
                "import {payload} from './dependency';\nconst formatted={value:payload.nativeOnlyCompletion};\n";

            await replace(unformatted);
            await until(() => hasButton("Format", true), "native formatting to be available");
            await page.press("Shift+Alt+f");
            await until(
                async () => (await editorText()) !== unformatted,
                "the native formatting shortcut to change the buffer",
            );
            const formatted = await editorText();

            assert.match(formatted, /const formatted = \{/);
            assert.match(formatted, /payload\.nativeOnlyCompletion/);
            assert.equal(
                readFileSync(f.disk, "utf8"),
                original,
                "Format changes only the buffer, never disk",
            );
            assert.equal(await text(SAVE_STATE), "Modified");
            const saveKey = await inPage<string>(
                "return JSON.stringify(/Mac|iPhone|iPad/.test(navigator.platform) ? 'Meta+S' : 'Control+S')",
            );

            await page.press(saveKey);
            await saved(f, formatted);
        } catch (error) {
            assert.fail(
                `${String(error)}; footer: ${await text(".file-edit-footer")}; editor: ${await text(".file-edit")}`,
            );
        } finally {
            await cancel();
        }
    },
);
