// Chromium DOM/transport contracts, synthetic Herdr and an authenticated paint-ack child only.
// The child does not validate GPU pixels. No socket discovery or personal PTY control.
import { cleanUp, openApp, root, scriptedModel, until } from "./helpers.ts";
import assert from "node:assert/strict";
import { mkdirSync, writeFileSync, mkdtempSync, rmSync } from "node:fs";
import { spawn } from "node:child_process";
import { createServer as socketServer } from "node:net";
import { createServer } from "node:http";
import { join } from "node:path";
import { after, test } from "node:test";
import { Browsers } from "../src/server/browser.ts";
import { findBrowser } from "../src/server/browser/discovery.ts";
import type { BrowserPage } from "../src/server/browser/page.ts";
import { VIEWPORTS } from "../src/server/browser/viewport.ts";
import { createHandler } from "../src/server/http.ts";
import { gpuiFixture } from "./terminal-grid-fixture.ts";

const chromium = findBrowser();

after(cleanUp);

async function value<T>(page: BrowserPage, expression: string): Promise<T> {
    return JSON.parse(await page.evaluate(`return JSON.stringify(${expression})`)) as T;
}

async function present(page: BrowserPage, selector: string) {
    await until(
        () => value(page, `!!document.querySelector(${JSON.stringify(selector)})`),
        selector,
    );
}

async function click(page: BrowserPage, selector: string) {
    await page.evaluate(`document.querySelector(${JSON.stringify(selector)}).click()`);
}

async function shot(page: BrowserPage, name: string) {
    const directory = process.env.PRIVATE_TERMINAL_SCREENSHOT_DIR;

    if (!directory) {
        return;
    }

    mkdirSync(directory, { recursive: true });
    await page.evaluate(
        `await document.fonts.ready; await new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)))`,
    );
    const captured = await page.screenshot();

    writeFileSync(join(directory, `${name}.jpg`), Buffer.from(captured.data, "base64"));
}

const snapshot = {
    boot_id: "fixture-boot",
    revision: 1,
    focused_workspace_id: "native-work",
    focused_tab_id: "native-tab",
    focused_pane_id: "native-agent",
    workspaces: [
        { workspace_id: "native-work", label: "ledger-api", active_tab_id: "native-tab" },
        { workspace_id: "native-work-0", label: "pixel-forge", active_tab_id: "native-tab-0" },
    ],
    tabs: [
        { tab_id: "native-tab", workspace_id: "native-work", label: "editor" },
        { tab_id: "native-git", workspace_id: "native-work", label: "lazygit" },
        { tab_id: "native-tab-0", workspace_id: "native-work-0", label: "review" },
    ],
    panes: [
        {
            pane_id: "native-agent",
            workspace_id: "native-work",
            tab_id: "native-tab",
            focused: true,
        },
        {
            pane_id: "native-shell",
            workspace_id: "native-work",
            tab_id: "native-tab",
            focused: false,
        },
        {
            pane_id: "native-agent-0",
            workspace_id: "native-work-0",
            tab_id: "native-tab-0",
            focused: false,
        },
    ],
};

function surface(width = 112, height = 30) {
    const middle = Math.floor(width / 2);
    const bottom = Math.floor(height * 0.58);
    const cells = Array.from({ length: width * height }, () => ({
        symbol: " ",
        fg: 0,
        bg: 0,
        modifier: 0,
        skip: false,
        hyperlink: null,
    }));

    const text = (x: number, y: number, line: string, fg = 0x02c0caf5, right = width) => {
        for (const [index, symbol] of [...line].entries()) {
            if (x + index < right && y < height) {
                cells[y * width + x + index] = { ...cells[y * width + x + index]!, symbol, fg };
            }
        }
    };

    [
        "// Synthetic fixture · no live terminal",
        "",
        "pub struct Book {",
        "    entries: Vec<Entry>,",
        "}",
        "",
        "impl Book {",
        "    pub fn post(&mut self, entry: Entry) {",
        "        self.entries.push(entry);",
        "    }",
        "",
        "    pub fn balance(&self) -> Decimal {",
        "        self.entries.iter()",
        "            .map(|entry| entry.amount)",
        "            .sum()",
        "    }",
        "}",
        "",
        "#[cfg(test)]",
        "mod tests {",
        "    use super::*;",
        "",
        "    #[test]",
        "    fn balances_entries() {",
        "        let mut book = Book::default();",
        "        book.post(Entry::credit(42));",
        "        book.post(Entry::debit(42));",
        "        assert_eq!(book.balance(), 0);",
        "    }",
        "",
        "    #[test]",
        "    fn rounds_in_minor_units() {",
        "        let amount = Money::usd(1299);",
        '        assert_eq!(amount.display(), "$12.99");',
        "    }",
        "}",
    ].forEach((line, row) => text(1, row + 1, line, row < 2 ? 0x027aa2f7 : 0x02c0caf5, middle));
    [
        "4396373 Add currency type",
        "8111f45 Fix rounding precision",
        "c1a8000 Add ledger entries",
        "",
        "ledger-api main",
        "$ git status --short",
        " M src/book.rs",
    ].forEach((line, row) => text(middle + 3, row + 1, line, row < 3 ? 0x029ece6a : 0x02c0caf5));
    [
        "running 2 tests",
        "",
        "test entries::balanced ... ok",
        "test entries::rounding ... ok",
        "",
        "test result: ok. 2 passed; 0 failed",
        "",
        "ledger-api main",
        "$ ",
    ].forEach((line, row) =>
        text(middle + 3, row + bottom + 2, line, line.includes("ok") ? 0x029ece6a : 0x02c0caf5),
    );

    for (let y = 0; y < height; y++) {
        text(middle, y, "│", 0x02565f89);
    }

    text(middle + 1, bottom, "─".repeat(width - middle - 1), 0x02565f89);

    return {
        boot_id: "fixture-boot",
        projection_revision: 1,
        surface_revision: 1,
        frame: {
            width,
            height,
            cells,
            cursor: {
                x: middle + 5,
                y: Math.min(height - 1, bottom + 10),
                visible: true,
                shape: 1,
            },
            hyperlinks: [],
            graphics: [],
        },
        panes: [
            {
                pane_id: "native-agent",
                focused: true,
                rect: { x: 0, y: 0, width: middle, height },
                inner_rect: { x: 0, y: 0, width: middle, height },
            },
            {
                pane_id: "native-shell",
                focused: false,
                rect: { x: middle + 1, y: 0, width: width - middle - 1, height: bottom },
                inner_rect: { x: middle + 1, y: 0, width: width - middle - 1, height: bottom },
            },
            {
                pane_id: "native-tests",
                focused: false,
                rect: {
                    x: middle + 1,
                    y: bottom + 1,
                    width: width - middle - 1,
                    height: height - bottom - 1,
                },
                inner_rect: {
                    x: middle + 1,
                    y: bottom + 1,
                    width: width - middle - 1,
                    height: height - bottom - 1,
                },
            },
        ],
        splits: [],
        popup: null,
        graphics: { assets: [], placements: [], retained_assets: [] },
    };
}

test("synthetic split fixture keeps each pane's text inside its region", () => {
    for (const width of [40, 112]) {
        const height = 36;
        const frame = surface(width, height).frame;
        const middle = Math.floor(width / 2);
        const divider = Math.floor(height * 0.58);

        for (let row = 0; row < height; row++) {
            if (row !== divider) {
                assert.equal(
                    frame.cells[row * width + middle + 1]?.symbol,
                    " ",
                    `right gutter at ${width} columns, row ${row}`,
                );
                assert.equal(frame.cells[row * width + middle + 2]?.symbol, " ");
            }
        }
    }
});

async function mockSocket(page: BrowserPage, autoPaint = true) {
    await page.evaluate(`
        window.fixtureGpuiAutoPaint = ${autoPaint};
        window.fixtureSockets = [];
        window.WebSocket = class {
            readyState = 1; sent = []; closed = false;
            constructor(url) { this.url = url; window.fixtureSockets.push(this); }
            send(text) {
                const frame = JSON.parse(text);
                this.sent.push(frame);
                if (frame.method === 'client_shell.surface.set' && !window.fixtureHoldInterest) {
                    queueMicrotask(() => {
                        this.receive({type:'response', requestId:frame.requestId, response:{result:{}}});
                        if (frame.params.active && window.fixtureSurface) this.receive({type:'surface', surface:window.fixtureSurface});
                    });
                }
            }
            close() { this.closed = true; this.readyState = 3; }
            receive(frame) { this.onmessage?.({data: JSON.stringify(frame)}); }
        };
    `);
}

async function ready(page: BrowserPage) {
    await present(page, '.terminal-grid[data-renderer="gpui"][data-renderer-state="ready"]');
}

async function frames(page: BrowserPage, waitForPaint = true) {
    const [cols, rows] = await value<[number, number]>(
        page,
        `(() => { const viewport = document.querySelector('.terminal-grid-viewport'); return [Math.max(20, Math.floor(viewport.clientWidth / 7.8)), Math.max(10, Math.floor(viewport.clientHeight / 20))]; })()`,
    );

    await page.evaluate(`window.fixtureSurface = ${JSON.stringify(surface(cols, rows))}; const ws = window.fixtureSockets.at(-1);
        ws.receive({type:'connected',welcome:{generation:1,methods:['client_shell.surface.set','pane.focus','pane.focus_direction','pane.split','pane.zoom','pane.close','tab.focus','tab.create','workspace.focus','workspace.create','command.invoke']}});
        ws.receive({type:'snapshot',snapshot:${JSON.stringify(snapshot)}});
        ws.receive({type:'surface',surface:${JSON.stringify(surface(cols, rows))}});
    `);
    await present(page, ".terminal-grid-interaction");

    if (waitForPaint) {
        await ready(page);
    }
}

test(
    "Private terminal: automatic retained control, acknowledged surface interest, safe reconnect and owner-only pool",
    {
        skip: chromium === undefined ? "no Chromium installed" : false,
        timeout: 90_000,
    },
    async (t) => {
        const app = await openApp(scriptedModel());

        app.piSessions.active.local.sockets = async () => [];
        const handler = createHandler({
            app,
            listen: { host: "127.0.0.1", port: 0 },
            restart: () => {},
        });
        const requests: { path: string; body: Record<string, unknown>; pocket?: string }[] = [];
        const pane = {
            id: "opaque-agent",
            nativeId: "native-agent",
            title: "Pi · ledger-api",
            agent: "pi",
            cwd: "/fixture/projects/ledger-api",
            state: "idle",
        };
        const shell = {
            id: "opaque-shell",
            nativeId: "native-shell",
            title: "Shell",
            cwd: "/fixture/projects/ledger-api",
            state: "shell",
        };
        let denied = false;
        let extraInstances = 0;
        let focusedWorkspace = "native-work";
        let rendererBuildAvailable = true;
        let rendererBuildReads = 0;
        const reads: string[] = [];
        const server = createServer(async (request, response) => {
            const path = new URL(request.url!, "http://fixture").pathname;

            if (path === "/herdr-renderer/build.json") {
                rendererBuildReads++;
                response.setHeader("Cache-Control", "no-store");
                response.setHeader("Content-Type", "application/json");
                response.statusCode = rendererBuildAvailable ? 200 : 404;
                response.end(
                    JSON.stringify(
                        rendererBuildAvailable
                            ? { schema: 2, kind: "live-terminal", entry: gpuiFixture.entry }
                            : { error: "Synthetic missing-build fixture" },
                    ),
                );

                return;
            }

            if (path === gpuiFixture.wasmPath) {
                response.setHeader("Content-Type", "application/wasm");
                response.end(gpuiFixture.wasm);

                return;
            }

            if (path === `/herdr-renderer/${gpuiFixture.entry}`) {
                response.setHeader("Cache-Control", "no-store");
                response.setHeader("Content-Type", "text/html");
                response.end(gpuiFixture.html);

                return;
            }

            if (!path.startsWith("/api/private")) {
                return handler(request, response);
            }

            response.setHeader("Content-Type", "application/json");
            response.setHeader("Cache-Control", "no-store");
            let raw = "";

            for await (const chunk of request) {
                raw += chunk;
            }

            const body = raw ? (JSON.parse(raw) as Record<string, unknown>) : {};

            if (request.method === "POST") {
                requests.push({ path, body, pocket: String(request.headers["x-pocket"]) });

                if (path.endsWith("/import-preview")) {
                    response.statusCode = 409;
                    response.end(
                        JSON.stringify({
                            error: "Synthetic import preview reached with terminal attached",
                        }),
                    );
                } else if (denied) {
                    response.statusCode = 403;
                    response.end(JSON.stringify({ error: "Private access ended" }));
                } else {
                    response.end(
                        JSON.stringify({
                            ticket: "fixture-ticket",
                            url: "/api/private-terminal?ticket=fixture-ticket",
                            expiresAt: Date.now() + 30_000,
                        }),
                    );
                }

                return;
            }

            reads.push(path);

            if (path === "/api/private") {
                response.end(
                    JSON.stringify({
                        warnings: [],
                        instances: [
                            {
                                id: "local",
                                label: "Local",
                                available: true,
                                workspaces: [
                                    {
                                        id: "work",
                                        nativeId: "native-work",
                                        active: focusedWorkspace === "native-work",
                                        label: "ledger-api",
                                        branch: "main",
                                        tabs: [
                                            {
                                                id: "tab",
                                                nativeId: "native-tab",
                                                label: "editor",
                                                panes: [pane, shell],
                                            },
                                            {
                                                id: "git",
                                                nativeId: "native-git",
                                                label: "lazygit",
                                                panes: [{ ...shell, id: "opaque-git" }],
                                            },
                                        ],
                                    },
                                    ...[
                                        "pixel-forge",
                                        "harbor-docs",
                                        "feat/multi-currency",
                                        "fix/rounding",
                                    ].map((label, index) => ({
                                        id: `work-${index}`,
                                        nativeId: `native-work-${index}`,
                                        active: focusedWorkspace === `native-work-${index}`,
                                        label,
                                        branch: index > 1 ? label : "main",
                                        tabs: [
                                            {
                                                id: `tab-${index}`,
                                                nativeId: `native-tab-${index}`,
                                                label: "agent",
                                                panes: [
                                                    {
                                                        ...pane,
                                                        id: `agent-${index}`,
                                                        nativeId: `native-agent-${index}`,
                                                        state: index > 1 ? "working" : "idle",
                                                    },
                                                ],
                                            },
                                        ],
                                    })),
                                ],
                            },
                            ...Array.from({ length: extraInstances }, (_, index) => ({
                                id: `extra-${index}`,
                                label: `Fixture ${index}`,
                                available: true,
                                workspaces: [
                                    {
                                        id: `extra-work-${index}`,
                                        nativeId: "native-work",
                                        label: `fixture-${index}`,
                                        tabs: [
                                            {
                                                id: `extra-tab-${index}`,
                                                nativeId: "native-tab",
                                                label: "shell",
                                                panes: [
                                                    {
                                                        ...pane,
                                                        id: `extra-pane-${index}`,
                                                        supportsImport: false,
                                                    },
                                                ],
                                            },
                                        ],
                                    },
                                ],
                            })),
                        ],
                    }),
                );

                return;
            }

            const isShell = !path.endsWith("opaque-agent");

            response.end(
                JSON.stringify({
                    pane: isShell ? shell : pane,
                    revision: "fixture-revision",
                    capturedAt: Date.now(),
                    canPrompt: !isShell,
                    canImport: !isShell,
                    warnings: [],
                    terminal:
                        "$ cargo test\n\nrunning 2 tests\ntest result: ok. 2 passed; 0 failed\n\nSynthetic fixture. Connect is mocked.",
                    entries: isShell
                        ? []
                        : [
                              {
                                  id: 1,
                                  kind: "user",
                                  text: "Add currency support to the ledger entries.",
                                  images: 0,
                              },
                              {
                                  id: 2,
                                  kind: "assistant",
                                  blocks: [
                                      {
                                          type: "text",
                                          text: "The ledger now carries a currency on each entry. Both balance and rounding tests pass.\n\nThis is a synthetic Chat fixture, not a real agent session.",
                                      },
                                  ],
                              },
                          ],
                }),
            );
        });
        const browsers = new Browsers({
            dataDir: join(root, "private-terminal-browser"),
            load: async () => undefined,
            save: () => {},
        });

        await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
        const base = `http://127.0.0.1:${(server.address() as { port: number }).port}`;

        try {
            const page = await browsers.open(1);

            await page.setViewport(VIEWPORTS.desktop);
            await page.navigate(`${base}/login?token=${encodeURIComponent(app.config.ownerToken)}`);
            await present(page, ".private-tabs");
            await mockSocket(page, false);
            await page.evaluate(
                `(await import('/store.js')).navigate(null, {privateId:"opaque-agent"})`,
            );
            await until(
                () => value(page, "window.fixtureSockets.length === 1"),
                "Terminal auto-connects on opening",
            );
            await present(page, ".sidebar .private-space-row");
            assert.equal(requests.length, 1, "opening desktop Terminal is control intent");
            assert.equal(
                await value(
                    page,
                    `document.querySelectorAll('.sidebar .private-space-row').length`,
                ),
                5,
            );
            assert.equal(
                await value(page, `document.querySelectorAll('.sidebar .private-pane-row').length`),
                5,
            );
            assert.equal(
                await value(page, `document.querySelectorAll('.sidebar .private-branches').length`),
                0,
            );
            assert.equal(
                await value(
                    page,
                    `document.querySelector('.sidebar').textContent.includes('/fixture/projects')`,
                ),
                false,
            );
            assert.equal(
                await value(page, `document.querySelectorAll('.private-tabbar button').length`),
                2,
            );
            await shot(page, "desktop-opening");
            assert.equal(
                await value(page, `!!document.querySelector('.private-topbar')`),
                false,
                "no redundant Shell/import header",
            );
            assert.equal(
                await value(page, `document.querySelectorAll('.sidebar .private-import').length`),
                5,
                "import icons belong to supported agent rows",
            );
            assert.equal(
                await value(page, `!!document.querySelector('.private-terminal-help[open]')`),
                false,
                "help starts as a compact icon",
            );
            assert.equal(requests.length, 1);
            assert.equal(requests[0]?.body.acknowledged, true);
            assert.ok(requests[0]?.pocket);
            assert.ok(Number(requests[0]?.body.cols) > 0);
            await frames(page, false);
            await t.test(
                "GPUI starts automatically, gates input until paint acknowledgement and carries live image assets",
                async () => {
                    const connectionsBefore = requests.length;

                    await present(page, ".terminal-grid-gpui");
                    await page.evaluate(`await document.fonts.ready;
                        await new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve)));`);
                    await until(
                        () =>
                            value(
                                page,
                                `!!document.querySelector('.terminal-grid-gpui')?.contentWindow
                            .fixtureGpui?.messages.some(message=>message.type==='gpui-present')`,
                            ),
                        "the authenticated child receives the current live surface",
                    );
                    assert.match(
                        await value<string>(
                            page,
                            "new URL(document.querySelector('.terminal-grid-gpui').src).hash",
                        ),
                        /^#[a-f0-9]{32}$/,
                    );
                    assert.deepEqual(
                        await value(
                            page,
                            `(() => {
                            const grid=document.querySelector('.terminal-grid');
                            const hit=grid.querySelector('.terminal-grid-interaction');
                            const child=grid.querySelector('.terminal-grid-gpui');
                            const a=hit.getBoundingClientRect(),b=child.getBoundingClientRect();
                            window.fixtureRendererNodes={grid,hit,input:grid.querySelector('.terminal-grid-input'),
                                child,socket:window.fixtureSockets[0],start:window.fixtureSockets[0].sent.length,
                                presentations:child.contentWindow.fixtureGpui.messages.filter(message=>message.type==='gpui-present').length};
                            return {renderer:grid.dataset.renderer,state:grid.dataset.rendererState,
                                enabled:grid.dataset.enabled,inputDisabled:window.fixtureRendererNodes.input.disabled,
                                canvas:!!grid.querySelector('canvas'),toggle:!!document.querySelector('.private-gpui-toggle'),
                                visibility:getComputedStyle(child).visibility,pointerEvents:getComputedStyle(child).pointerEvents,
                                matchesInteraction:['left','top','width','height'].every(key=>Math.abs(a[key]-b[key])<1)};
                        })()`,
                        ),
                        {
                            renderer: "gpui",
                            state: "loading",
                            enabled: "false",
                            inputDisabled: true,
                            canvas: false,
                            toggle: false,
                            visibility: "hidden",
                            pointerEvents: "none",
                            matchesInteraction: true,
                        },
                        "the sole painter starts hidden and the retained interaction layer cannot send input yet",
                    );
                    await page.evaluate(`window.fixtureTryText=text=>{
                        const input=document.querySelector('.terminal-grid-input');
                        input.value=text;input.dispatchEvent(new InputEvent('input',{bubbles:true,data:text}));
                    };
                    window.fixtureTryText('must-not-replay-before-paint');
                    const input=document.querySelector('.terminal-grid-input');
                    input.dispatchEvent(new KeyboardEvent('keydown',{key:'Enter',bubbles:true,cancelable:true}));
                    const hit=document.querySelector('.terminal-grid-interaction'),r=hit.getBoundingClientRect();
                    hit.dispatchEvent(new PointerEvent('pointerdown',{bubbles:true,button:0,pointerId:1,
                        clientX:r.left+2,clientY:r.top+2}));`);
                    assert.deepEqual(
                        await value(
                            page,
                            "window.fixtureSockets[0].sent.slice(window.fixtureRendererNodes.start).filter(frame=>frame.type!=='resize')",
                        ),
                        [],
                        "neither typing, keys nor focus actions escape the initial paint fence",
                    );
                    // The real transport processes the asset barrier before the surface. The mock
                    // child records what production serializes; it does not decode or paint pixels.
                    await page.evaluate(`window.fixtureRendererOriginalSurface=window.fixtureSurface;
                        const key={source:{Terminal:{target:{Pane:{pane_id:'native-agent'}},image_id:'18446744073709551615'}},
                            image_width:1,image_height:1,format:'Rgb',data_len:3,data_fingerprint:'18446744073709551614'};
                        window.fixtureSockets[0].receive({type:'images',images:[{key,serial:1,encoding:'base64',data:'/wAA'}]});
                        const placement={asset:key,logical_placement_id:1,x:0,y:0,cols:1,rows:1,
                            source_x:0,source_y:0,source_width:0,source_height:0,x_offset:0,y_offset:0,z:1,scrollback_offset:0};
                        window.fixtureSurface={...window.fixtureSurface,surface_revision:2,
                            frame:{...window.fixtureSurface.frame,cells:window.fixtureSurface.frame.cells.map(
                                (cell,index)=>index===0?{...cell,symbol:'G'}:cell)},
                            graphics:{assets:[],placements:[placement],retained_assets:[]}};
                        window.fixtureSockets[0].receive({type:'surface',surface:window.fixtureSurface});
                        await new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve)));`);
                    assert.equal(
                        await value(
                            page,
                            `document.querySelector('.terminal-grid-gpui').contentWindow.fixtureGpui.messages
                            .filter(message=>message.type==='gpui-present').length`,
                        ),
                        await value(page, "window.fixtureRendererNodes.presentations"),
                        "a later complete presentation waits behind the outstanding child paint",
                    );
                    await page.evaluate(
                        "document.querySelector('.terminal-grid-gpui').contentWindow.fixtureGpui.paint()",
                    );
                    await until(
                        () =>
                            value(
                                page,
                                `document.querySelector('.terminal-grid-gpui').contentWindow.fixtureGpui.messages
                            .some(message=>message.presentation?.surface.surface_revision===2)`,
                            ),
                        "the latest live surface follows the matching acknowledgement",
                    );
                    assert.deepEqual(
                        await value(
                            page,
                            `(() => {
                            const {surface,images}=document.querySelector('.terminal-grid-gpui').contentWindow.fixtureGpui.messages
                                .find(message=>message.presentation?.surface.surface_revision===2).presentation;
                            return {boot:surface.boot_id,projection:surface.projection_revision,symbol:surface.frame.cells[0].symbol,
                                imageId:images[0].key.source.Terminal.image_id,fingerprint:images[0].key.data_fingerprint,
                                data:images[0].data,placementHasAsset:JSON.stringify(surface.graphics.placements[0].asset)===JSON.stringify(images[0].key)};
                        })()`,
                        ),
                        {
                            boot: "fixture-boot",
                            projection: 1,
                            symbol: "G",
                            imageId: "18446744073709551615",
                            fingerprint: "18446744073709551614",
                            data: "/wAA",
                            placementHasAsset: true,
                        },
                        "image bytes and exact 64-bit identities accompany the surface that references them",
                    );
                    await page.evaluate(`window.fixtureGpuiAutoPaint=true;
                        document.querySelector('.terminal-grid-gpui').contentWindow.fixtureGpui.paint();`);
                    await ready(page);
                    await page.evaluate("window.fixtureTryText('after-first-paint')");
                    assert.deepEqual(
                        await value(
                            page,
                            `window.fixtureSockets[0].sent.slice(window.fixtureRendererNodes.start)
                            .filter(frame=>frame.type!=='resize').map(frame=>({type:frame.type,pane:frame.paneId,events:frame.events}))`,
                        ),
                        [
                            {
                                type: "input",
                                pane: "native-agent",
                                events: [{ TextCommit: "after-first-paint" }],
                            },
                        ],
                        "readiness admits only fresh input and never replays blocked edits",
                    );
                    assert.equal(await value(page, "window.fixtureSockets.length"), 1);
                    assert.equal(requests.length, connectionsBefore);
                },
            );
            await t.test(
                "renderer failure has no Canvas fallback and retry retains the grid, input and live connection",
                async () => {
                    const connectionsBefore = requests.length;

                    await page.evaluate(`const nodes=window.fixtureRendererNodes;
                        nodes.session=new URL(nodes.child.src).hash;
                        nodes.start=nodes.socket.sent.length;
                        nodes.child.contentWindow.fixtureGpui.fail();`);
                    await present(
                        page,
                        '.terminal-grid[data-renderer-state="error"] .terminal-grid-renderer-retry',
                    );
                    assert.equal(
                        await value(
                            page,
                            "document.querySelector('.terminal-grid').dataset.renderer",
                        ),
                        "gpui",
                    );
                    assert.equal(
                        await value(
                            page,
                            "document.querySelector('.terminal-grid-input').disabled",
                        ),
                        true,
                    );
                    assert.equal(
                        await value(page, "!!document.querySelector('.terminal-grid canvas')"),
                        false,
                    );
                    const failure = await value<string>(
                        page,
                        "document.querySelector('.terminal-grid').textContent",
                    );

                    assert.match(failure, /renderer unavailable/i);
                    assert.doesNotMatch(
                        failure,
                        /Untrusted child failure details|Canvas2D is active|fallback is active/,
                    );
                    await page.evaluate("window.fixtureTryText('must-not-replay-after-failure')");
                    rendererBuildAvailable = false;
                    const buildsBeforeRetry = rendererBuildReads;

                    await click(page, ".terminal-grid-renderer-retry");
                    await until(
                        () => rendererBuildReads > buildsBeforeRetry,
                        "retry requests a fresh manifest",
                    );
                    await present(
                        page,
                        '.terminal-grid[data-renderer-state="error"] .terminal-grid-renderer-retry',
                    );
                    assert.equal(
                        await value(page, "!!document.querySelector('.terminal-grid-gpui')"),
                        false,
                    );
                    assert.equal(
                        await value(
                            page,
                            "document.querySelector('.terminal-grid-input').disabled",
                        ),
                        true,
                    );
                    rendererBuildAvailable = true;
                    await page.evaluate("window.fixtureGpuiAutoPaint=false");
                    await click(page, ".terminal-grid-renderer-retry");
                    await until(
                        () =>
                            value(
                                page,
                                `!!document.querySelector('.terminal-grid-gpui')?.contentWindow.fixtureGpui
                            ?.messages.some(message=>message.type==='gpui-present')`,
                            ),
                        "retry creates a new authenticated child on the retained transport",
                    );
                    assert.deepEqual(
                        await value(
                            page,
                            `(() => {
                            const nodes=window.fixtureRendererNodes,grid=document.querySelector('.terminal-grid');
                            const child=grid.querySelector('.terminal-grid-gpui');
                            return [grid===nodes.grid,grid.querySelector('.terminal-grid-interaction')===nodes.hit,
                                grid.querySelector('.terminal-grid-input')===nodes.input,
                                window.fixtureSockets[0]===nodes.socket,!nodes.socket.closed,
                                child!==nodes.child,new URL(child.src).hash!==nodes.session,
                                grid.dataset.rendererState==='loading',nodes.input.disabled];
                        })()`,
                        ),
                        Array(9).fill(true),
                    );
                    await page.evaluate(`window.fixtureTryText('must-not-replay-during-retry');
                        window.fixtureGpuiAutoPaint=true;
                        document.querySelector('.terminal-grid-gpui').contentWindow.fixtureGpui.paint();`);
                    await ready(page);
                    await page.evaluate("window.fixtureTryText('after-renderer-retry')");
                    assert.deepEqual(
                        await value(
                            page,
                            `window.fixtureSockets[0].sent.slice(window.fixtureRendererNodes.start)
                            .filter(frame=>frame.type!=='resize').map(frame=>({type:frame.type,pane:frame.paneId,events:frame.events}))`,
                        ),
                        [
                            {
                                type: "input",
                                pane: "native-agent",
                                events: [{ TextCommit: "after-renderer-retry" }],
                            },
                        ],
                        "renderer failure/retry neither reconnects, changes native interest nor replays input",
                    );
                    assert.equal(await value(page, "window.fixtureSockets.length"), 1);
                    assert.equal(requests.length, connectionsBefore);
                    await page.evaluate(`window.fixtureSurface=window.fixtureRendererOriginalSurface;
                        window.fixtureSockets[0].receive({type:'images',images:[]});
                        window.fixtureSockets[0].receive({type:'surface',surface:window.fixtureSurface});`);
                    await ready(page);
                },
            );
            await t.test(
                "idle metadata/surface updates do not re-resize the shared terminal",
                async () => {
                    await page.evaluate(`await document.fonts.ready;
                    await new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve)));
                    window.fixtureResizeBaseline=window.fixtureSockets[0].sent.filter(f=>f.type==='resize').length;
                    window.fixtureOriginalSurface=structuredClone(window.fixtureSurface);`);

                    for (let revision = 100; revision < 105; revision++) {
                        await page.evaluate(`window.fixtureSockets[0].receive({type:'snapshot',
                        snapshot:{...${JSON.stringify(snapshot)},revision:${revision}}});`);
                        await until(
                            () =>
                                value(
                                    page,
                                    "document.querySelector('.terminal-grid').dataset.enabled==='false'",
                                ),
                            "metadata update temporarily fences terminal input",
                        );
                        await page.evaluate(`await new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve)));
                        window.fixtureSurface={...window.fixtureOriginalSurface,
                            projection_revision:${revision},surface_revision:${revision},
                            panes:window.fixtureOriginalSurface.panes.map(p=>({...p,alternate_screen_active:true,mouse_reporting:true}))};
                        window.fixtureSockets[0].receive({type:'surface',surface:window.fixtureSurface});`);
                        await until(
                            () =>
                                value(
                                    page,
                                    "document.querySelector('.terminal-grid').dataset.enabled==='true'",
                                ),
                            "matching full-screen surface restores terminal input",
                        );
                        await page.evaluate(
                            "await new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve)))",
                        );
                    }

                    assert.equal(
                        await value(
                            page,
                            "window.fixtureSockets[0].sent.filter(f=>f.type==='resize').length-window.fixtureResizeBaseline",
                        ),
                        0,
                        "view-only full-screen updates must not keep resizing the pane seen by other clients",
                    );
                    await page.evaluate(`window.fixtureSurface=window.fixtureOriginalSurface;
                    window.fixtureSockets[0].receive({type:'snapshot',snapshot:${JSON.stringify(snapshot)}});
                    window.fixtureSockets[0].receive({type:'surface',surface:window.fixtureSurface});`);
                },
            );
            await t.test(
                "temporary diagnostics copy metadata and provide a blocked-clipboard fallback",
                async () => {
                    await page.evaluate(`window.fixtureClipboardDescriptor=Object.getOwnPropertyDescriptor(navigator,'clipboard');
                    Object.defineProperty(navigator,'clipboard',{configurable:true,value:{
                        writeText:async text=>{window.fixtureDiagnosticsCopy=text}
                    }});
                    window.fixtureDiagnosticSurface=window.fixtureSurface;
                    window.fixtureSockets[0].receive({type:'surface',surface:{...window.fixtureSurface,
                        panes:window.fixtureSurface.panes.map(p=>({...p,scroll:{offset_from_bottom:4,max_offset_from_bottom:100,viewport_rows:24},alternate_screen_active:true}))}});`);

                    try {
                        await click(page, ".private-terminal-help summary");
                        const inputBefore = await value<number>(
                            page,
                            "window.fixtureSockets[0].sent.filter(f=>['input','popup-input','clipboard-image','resize'].includes(f.type)).length",
                        );

                        await page.click({ selector: ".private-diagnostics-copy" });
                        await until(
                            () => value(page, "typeof window.fixtureDiagnosticsCopy==='string'"),
                            "diagnostic clipboard export",
                        );
                        assert.equal(
                            await value(page, "JSON.parse(window.fixtureDiagnosticsCopy).kind"),
                            "pi-coop-terminal-diagnostics",
                        );
                        assert.equal(
                            await value(
                                page,
                                "JSON.parse(window.fixtureDiagnosticsCopy).latest.surface.panes[0].offset",
                            ),
                            4,
                            "the report includes actual received native scroll metadata",
                        );
                        assert.equal(
                            await value(
                                page,
                                "document.querySelector('.private-diagnostics-report').value===window.fixtureDiagnosticsCopy",
                            ),
                            true,
                            "a stable selectable snapshot is available alongside clipboard copy",
                        );
                        await page.evaluate(
                            "navigator.clipboard.writeText=async()=>{throw new Error('blocked')}",
                        );
                        await page.click({ selector: ".private-diagnostics-copy" });
                        await until(
                            () =>
                                value(
                                    page,
                                    "document.querySelector('.private-terminal-diagnostics').textContent.includes('Copy was blocked')",
                                ),
                            "clipboard failure explains the manual-copy fallback",
                        );
                        assert.equal(
                            await value(
                                page,
                                "document.querySelector('.private-diagnostics-report').readOnly",
                            ),
                            true,
                        );
                        assert.equal(
                            await value(
                                page,
                                "window.fixtureSockets[0].sent.filter(f=>['input','popup-input','clipboard-image','resize'].includes(f.type)).length",
                            ),
                            inputBefore,
                            "export does not send terminal input or resize shared panes",
                        );
                    } finally {
                        await page.evaluate(`if(window.fixtureClipboardDescriptor){
                        Object.defineProperty(navigator,'clipboard',window.fixtureClipboardDescriptor)
                    }else{delete navigator.clipboard}
                    document.querySelector('.private-terminal-help').open=false;
                    window.fixtureSockets[0].receive({type:'surface',surface:window.fixtureDiagnosticSurface});
                    document.querySelector('.terminal-grid-input').focus();`);
                    }
                },
            );
            await t.test(
                "native worktree hierarchy, local folds and retained native navigation",
                async () => {
                    // Native snapshots carry repo membership and branch updates before the next HTTP poll.
                    await page.evaluate(`window.fixtureSockets[0].receive({type:'snapshot',snapshot:{...${JSON.stringify(snapshot)}, workspaces:[
                {...${JSON.stringify(snapshot.workspaces[0])}, branch:'dev', worktree:{key:'ledger-repo',label:'ledger-api',is_linked_worktree:false}},
                ${JSON.stringify(snapshot.workspaces[1])},
                {workspace_id:'native-work-2',label:'short-checkout',branch:'feature/multi-currency',worktree:{key:'ledger-repo',label:'ledger-api',is_linked_worktree:true}},
                {workspace_id:'native-work-3',label:'fix/rounding',branch:'fix/rounding',worktree:{key:'ledger-repo',label:'ledger-api',is_linked_worktree:true}}
            ]}})`);
                    await until(
                        () =>
                            value(
                                page,
                                `document.querySelectorAll('.sidebar .private-worktree-children .private-space-row').length === 2`,
                            ),
                        "native worktree hierarchy",
                    );
                    assert.equal(
                        await value(
                            page,
                            `document.querySelector('.sidebar .private-space-row .session-meta').textContent`,
                        ),
                        "dev",
                        "native branch replaces stale HTTP branch",
                    );
                    const sentBeforeFold = await value<number>(
                        page,
                        `window.fixtureSockets[0].sent.length`,
                    );

                    await page.click({ selector: ".sidebar .private-worktree-toggle" });
                    assert.equal(
                        await value(page, `window.fixtureSockets[0].sent.length`),
                        sentBeforeFold,
                        "folding never sends a Herdr command",
                    );
                    assert.equal(
                        await value(
                            page,
                            `document.querySelectorAll('.sidebar .private-space-row').length`,
                        ),
                        3,
                    );
                    assert.equal(
                        await value(
                            page,
                            `document.activeElement?.matches('.terminal-grid-input')`,
                        ),
                        true,
                        "folding keeps terminal typing focus",
                    );
                    await page.click({ selector: ".sidebar .private-worktree-toggle" });
                    await page.click({
                        selector: ".sidebar .private-worktree-children .private-space-row",
                    });
                    assert.equal(
                        await value(
                            page,
                            `window.fixtureSockets[0].sent.filter(frame => frame.method === 'workspace.focus').at(-1)?.params.workspace_id`,
                        ),
                        "native-work-2",
                        "linked rows target native workspace IDs",
                    );
                    assert.equal(requests.length, 1, "worktree navigation retains the connection");
                    await shot(page, "desktop-worktrees");
                },
            );
            await frames(page);
            assert.equal(
                await value(
                    page,
                    `document.activeElement?.getAttribute('aria-label') === 'Terminal input'`,
                ),
                true,
                "desktop Terminal is immediately ready for typing",
            );
            assert.deepEqual(
                await value(
                    page,
                    `await (async () => { const { terminalKeymap } = await import('/private-terminal.js'); const keys = terminalKeymap({server_keybindings_toml:'[keys]\\nprefix=[]\\nsplit_vertical=""\\nnew_tab="cmd+d"\\n[keys.indexed]\\ntabs="alt"'}); return [keys.prefixes.has('C:b'),keys.chords.has(':v'),keys.direct.get('M:d'),keys.direct.get('A:2')]; })()`,
                ),
                [true, false, "tab-new", "tab-2"],
                "profile unbinding, fallback prefix, collision ownership and indexed keys match GPUI",
            );
            await shot(page, "desktop-connected");
            await page.setViewport({ ...VIEWPORTS.desktop, width: 2000, height: 1250 });
            await frames(page);
            await shot(page, "user-2000");
            await page.setViewport(VIEWPORTS.desktop);
            await frames(page);
            assert.equal(
                await value(page, `!!document.querySelector('[aria-label="Herdr actions"]')`),
                false,
                "no action dropdown",
            );
            assert.equal(
                await value(
                    page,
                    "getComputedStyle(document.querySelector('.private-mobile-terminal-nav')).display",
                ),
                "none",
                "the quick-action bar stays mobile-only",
            );
            assert.equal(
                await value(
                    page,
                    `getComputedStyle(document.querySelector('.terminal-keyboard')).display`,
                ),
                "none",
                "desktop is keyboard-first",
            );
            await page.evaluate(`document.querySelector('.private-view-switch button').focus()`);
            await page.press("Meta+d");
            assert.equal(
                await value(
                    page,
                    `window.fixtureSockets[0].sent.some(frame => frame.method === 'pane.split')`,
                ),
                false,
                "shortcuts require terminal keyboard focus",
            );
            await page.evaluate(`document.querySelector('.terminal-grid-input').focus()`);
            await page.press("Meta+d");
            await until(
                () =>
                    value(
                        page,
                        `window.fixtureSockets[0].sent.some(frame => frame.method === 'pane.split')`,
                    ),
                "GPUI split shortcut",
            );
            assert.equal(
                await value(
                    page,
                    `window.fixtureSockets[0].sent.find(frame => frame.method === 'pane.split').params.direction`,
                ),
                "right",
            );

            for (const letter of ["c", "d", "a"]) {
                await page.press(`Control+${letter}`);
                assert.equal(
                    await value(
                        page,
                        `window.fixtureSockets[0].sent.some(frame => frame.type === 'input' && frame.events.some(event => event.Key?.code?.Char === '${letter}' && event.Key.modifiers === 2))`,
                    ),
                    true,
                    `Ctrl+${letter} remains PTY input`,
                );
            }

            await page.press("Control+b");
            await page.press("c");
            assert.equal(
                await value(
                    page,
                    `window.fixtureSockets[0].sent.some(frame => frame.method === 'tab.create')`,
                ),
                true,
                "default Herdr prefix chord creates a tab",
            );
            await page.press("Control+b");
            await page.press("Shift");
            await page.press("Shift+n");
            assert.equal(
                await value(
                    page,
                    `window.fixtureSockets[0].sent.some(frame => frame.method === 'workspace.create')`,
                ),
                true,
                "modifier keydown does not cancel an armed prefix",
            );
            await page.press("Meta+Shift+Enter");
            await page.press("Meta+Alt+ArrowRight");
            assert.equal(
                await value(
                    page,
                    `window.fixtureSockets[0].sent.some(frame => frame.method === 'pane.zoom')`,
                ),
                true,
            );
            assert.equal(
                await value(
                    page,
                    `window.fixtureSockets[0].sent.some(frame => frame.method === 'pane.focus_direction' && frame.params.direction === 'right')`,
                ),
                true,
            );
            await page.evaluate(`window.confirm = () => false`);
            await page.press("Control+b");
            await page.press("x");
            assert.equal(
                await value(
                    page,
                    `window.fixtureSockets[0].sent.some(frame => frame.method === 'pane.close')`,
                ),
                false,
                "close needs explicit confirmation",
            );
            await page.evaluate(`window.confirm = () => true`);
            await page.press("Control+b");
            await page.press("x");
            assert.equal(
                await value(
                    page,
                    `window.fixtureSockets[0].sent.find(frame => frame.method === 'pane.close').confirmed`,
                ),
                true,
            );
            const configured = {
                ...snapshot,
                server_keybindings_toml:
                    '[keys]\nprefix = "ctrl+a"\nsplit_vertical = ["alt+s", "prefix+v"]\nzoom = "prefix+f"\nswitch_tab = "alt+1..9"',
                commands: [{ command_id: "fixture-command", binding_labels: ["ctrl+alt+r"] }],
            };

            await page.evaluate(
                `window.fixtureSockets[0].receive({type:'snapshot', snapshot:${JSON.stringify(configured)}})`,
            );
            await page.press("Alt+s");
            await page.press("Control+a");
            await page.press("v");
            await page.press("Control+Alt+r");
            await page.press("Alt+2");
            assert.equal(
                await value(
                    page,
                    `window.fixtureSockets[0].sent.filter(frame => frame.method === 'pane.split').length`,
                ),
                3,
                "configured direct and prefix bindings dispatch once each",
            );
            assert.equal(
                await value(
                    page,
                    `window.fixtureSockets[0].sent.some(frame => frame.method === 'command.invoke' && frame.params.command_id === 'fixture-command')`,
                ),
                true,
                "advertised custom binding dispatches its native command",
            );
            assert.equal(
                await value(
                    page,
                    `window.fixtureSockets[0].sent.some(frame => frame.method === 'tab.focus' && frame.params.tab_id === 'native-git')`,
                ),
                true,
                "configured indexed binding uses snapshot tab IDs",
            );
            assert.equal(
                await value(
                    page,
                    `(() => { const ids = window.fixtureSockets[0].sent.filter(frame => frame.type === 'request').map(frame => frame.requestId); return new Set(ids).size === ids.length; })()`,
                ),
                true,
                "native requests have unique IDs",
            );
            assert.equal(
                await value(page, "document.documentElement.scrollWidth <= innerWidth"),
                true,
            );
            await page.evaluate(
                `const input = document.querySelector('.terminal-grid-input'); input.focus(); input.value = 'fixture text'; input.dispatchEvent(new InputEvent('input', {bubbles:true, data:'fixture text'}));`,
            );
            await until(
                () =>
                    value(
                        page,
                        `window.fixtureSockets[0].sent.some(frame => frame.type === 'input')`,
                    ),
                "semantic input",
            );
            assert.equal(
                await value(
                    page,
                    `window.fixtureSockets[0].sent.filter(frame => frame.type === 'input').at(-1).paneId`,
                ),
                "native-agent",
            );
            assert.equal(
                await value(
                    page,
                    `window.fixtureSockets[0].sent.every(frame => frame.bootId === 'fixture-boot')`,
                ),
                true,
            );
            await page.evaluate(
                `const canvas = document.createElement('canvas'); canvas.width = 2; canvas.height = 2; canvas.getContext('2d').fillRect(0,0,2,2); const blob = await new Promise(resolve => canvas.toBlob(resolve, 'image/png')); const transfer = new DataTransfer(); transfer.items.add(new File([blob], 'fixture.png', {type:'image/png'})); document.querySelector('.terminal-grid-input').dispatchEvent(new ClipboardEvent('paste', {clipboardData:transfer,bubbles:true,cancelable:true}));`,
            );
            await until(
                () =>
                    value(
                        page,
                        `window.fixtureSockets[0].sent.some(frame => frame.type === 'clipboard-image')`,
                    ),
                "explicit image paste reaches gateway",
            );
            assert.deepEqual(
                await value(
                    page,
                    `window.fixtureSockets[0].sent.find(frame => frame.type === 'clipboard-image').target`,
                ),
                { Pane: "native-agent" },
            );

            // Real keyboard/click navigation with asynchronous native projections keeps input ownership.
            const project = async (
                paneId: string,
                tabId: string,
                revision: number,
                expectWarm = false,
            ) => {
                const next = {
                    ...snapshot,
                    revision,
                    focused_pane_id: paneId,
                    focused_tab_id: tabId,
                    panes: snapshot.panes.map((pane) => ({
                        ...pane,
                        focused: pane.pane_id === paneId,
                        ...(pane.pane_id === paneId ? { tab_id: tabId } : {}),
                    })),
                };
                const frame = surface();

                frame.projection_revision = revision;
                frame.surface_revision = revision;
                frame.panes = frame.panes.map((pane) => ({
                    ...pane,
                    focused: pane.pane_id === paneId,
                }));
                await page.evaluate(
                    `window.fixtureSockets[0].receive({type:'snapshot', snapshot:${JSON.stringify(next)}})`,
                );
                assert.equal(
                    await value(
                        page,
                        "document.querySelector('.terminal-grid-input') === window.fixtureInput",
                    ),
                    true,
                    "metadata gaps preserve the renderer textarea node",
                );

                if (expectWarm) {
                    assert.equal(
                        await value(
                            page,
                            "document.querySelector('.private-terminal-preview') === null",
                        ),
                        true,
                        "same-view metadata gaps must not cover retained pixels with a text preview",
                    );
                }

                await page.evaluate(
                    `window.fixtureSurface = ${JSON.stringify(frame)}; window.fixtureSockets[0].receive({type:'surface',surface:window.fixtureSurface})`,
                );
            };

            const focused = () =>
                value<boolean>(
                    page,
                    `document.activeElement === document.querySelector('.terminal-grid-input') && !document.activeElement.disabled`,
                );
            const lastInputPane = () =>
                value<string>(
                    page,
                    `window.fixtureSockets[0].sent.filter(frame => frame.type === 'input').at(-1)?.paneId`,
                );

            await page.evaluate(
                `window.fixtureInput = document.querySelector('.terminal-grid-input'); window.fixtureInput.focus()`,
            );
            await page.evaluate(`window.fixturePainter = document.querySelector('.terminal-grid-gpui');
                window.fixtureGpuiAutoPaint = false;
                window.fixtureInput.dispatchEvent(new CompositionEvent('compositionstart', {bubbles:true}));`);
            await project("native-agent", "native-tab", 20, true);
            await until(
                () =>
                    value(
                        page,
                        `window.fixturePainter.contentWindow.fixtureGpui.messages.at(-1)?.presentation?.surface.projection_revision === 20`,
                    ),
                "same-pane metadata reaches the warm painter",
            );
            assert.equal(
                await focused(),
                true,
                "same-target metadata/paint gaps preserve native editor focus",
            );
            await page.evaluate(`window.fixtureGpuiAutoPaint = true;
                window.fixturePainter.contentWindow.fixtureGpui.paint();`);
            await ready(page);
            await page.evaluate(
                `window.fixtureInput.dispatchEvent(new CompositionEvent('compositionend', {bubbles:true,data:'same-pane-composition'}))`,
            );
            assert.equal(
                await value(
                    page,
                    `window.fixtureSockets[0].sent.some(frame => frame.type === 'input' && frame.events.some(event => event.TextCommit === 'same-pane-composition'))`,
                ),
                true,
                "live composition survives same-target metadata and its paint receipt",
            );
            await page.evaluate("window.fixtureGpuiAutoPaint = false");
            await page.press("Meta+Alt+ArrowRight");
            await project("native-shell", "native-tab", 2, true);
            await until(
                () =>
                    value(
                        page,
                        `window.fixturePainter.contentWindow.fixtureGpui.messages.at(-1)?.presentation?.surface.projection_revision === 2`,
                    ),
                "split focus reaches the retained painter without a clear",
            );
            assert.deepEqual(
                await value(
                    page,
                    `({same:document.querySelector('.terminal-grid-gpui') === window.fixturePainter,
                    visible:getComputedStyle(window.fixturePainter).visibility,
                    loading:!!document.querySelector('.terminal-grid-renderer-status'),
                    inputDisabled:window.fixtureInput.disabled})`,
                ),
                { same: true, visible: "visible", loading: false, inputDisabled: true },
                "split focus keeps valid pixels visible while its new input target awaits paint",
            );
            await page.evaluate(`window.fixtureGpuiAutoPaint = true;
                window.fixturePainter.contentWindow.fixtureGpui.paint();`);
            await until(focused, "keyboard navigation restores terminal focus after a new surface");
            await page.press("q");
            assert.equal(
                await lastInputPane(),
                "native-shell",
                "typing immediately after pane navigation reaches the new pane",
            );
            await page.click({ selector: ".private-tabbar button:nth-child(2)" });
            await project("native-agent", "native-git", 3);
            await until(
                focused,
                "tab click restores terminal focus without a second terminal click",
            );
            await page.press("j");
            assert.equal(
                await lastInputPane(),
                "native-agent",
                "typing after tab navigation reaches its new pane",
            );
            await page.evaluate(
                `const input = window.fixtureInput; input.dispatchEvent(new CompositionEvent('compositionstart', {bubbles:true})); (await import('/store.js')).navigate(null, {privateId:"opaque-shell"})`,
            );
            await project("native-shell", "native-tab", 4);
            assert.equal(
                await value(
                    page,
                    "document.querySelector('.terminal-grid-input') === window.fixtureInput",
                ),
                true,
                "same-instance route navigation retains the actual textarea DOM",
            );
            await page.evaluate(
                `window.fixtureInput.dispatchEvent(new CompositionEvent('compositionend', {bubbles:true,data:'old-pane-composition'}))`,
            );
            await until(
                focused,
                "opaque route navigation restores typing focus after IME completion",
            );
            assert.equal(
                await value(
                    page,
                    `window.fixtureSockets[0].sent.some(frame => frame.type === 'input' && JSON.stringify(frame).includes('old-pane-composition'))`,
                ),
                false,
                "old IME composition never leaks into the new pane",
            );
            await page.press("k");
            assert.equal(await lastInputPane(), "native-shell");
            assert.equal(requests.length, 1, "all navigation retains one WebSocket and helper");
            await page.evaluate(
                `const dialog = document.createElement('dialog'); dialog.id='fixture-dialog'; dialog.innerHTML='<input aria-label="Fixture rename">'; document.body.append(dialog); dialog.showModal(); dialog.querySelector('input').focus()`,
            );
            await project("native-shell", "native-tab", 5);
            assert.equal(
                await value(
                    page,
                    "document.activeElement === document.querySelector('#fixture-dialog input')",
                ),
                true,
                "asynchronous snapshots never steal rename/form focus",
            );
            await page.evaluate(
                `document.querySelector('#fixture-dialog').close(); document.querySelector('#fixture-dialog').remove(); (await import('/store.js')).navigate(null, {privateId:"opaque-agent"}); window.fixtureInput.focus()`,
            );
            await project("native-agent", "native-tab", 1);
            await until(focused, "terminal focus resumes after explicitly leaving the form");

            // Two inhabited workspaces in one instance: native focus and the paint bridge follow B.
            await page.click({
                selector: '.sidebar .private-space-row[data-workspace-id="native-work-0"]',
            });
            assert.equal(
                await value(
                    page,
                    `window.fixtureSockets[0].sent.filter(frame => frame.method === 'workspace.focus').at(-1)?.params.workspace_id`,
                ),
                "native-work-0",
                "Space B uses its native workspace ID, never its opaque route ID",
            );
            focusedWorkspace = "native-work-0";
            const workspaceB = {
                ...snapshot,
                revision: 6,
                focused_workspace_id: "native-work-0",
                focused_tab_id: "native-tab-0",
                focused_pane_id: "native-agent-0",
            };
            const frameB = surface();

            frameB.projection_revision = 6;
            frameB.surface_revision = 6;
            frameB.panes = [
                {
                    ...frameB.panes[0]!,
                    pane_id: "native-agent-0",
                    focused: true,
                    rect: { x: 0, y: 0, width: 112, height: 30 },
                    inner_rect: { x: 0, y: 0, width: 112, height: 30 },
                },
            ];
            frameB.frame.cells = frameB.frame.cells.map((cell) => ({ ...cell, symbol: " " }));
            [..."SPACE B NATIVE SURFACE"].forEach((symbol, index) => {
                frameB.frame.cells[index]!.symbol = symbol;
            });
            await page.evaluate(
                `window.fixtureSockets[0].receive({type:'snapshot',snapshot:${JSON.stringify(workspaceB)}}); window.fixtureSurface=${JSON.stringify(frameB)}; window.fixtureSockets[0].receive({type:'surface',surface:window.fixtureSurface})`,
            );
            await until(focused, "workspace switch keeps typing focused on B");
            await page.press("b");
            assert.equal(
                await lastInputPane(),
                "native-agent-0",
                "immediate workspace typing targets B",
            );
            await until(
                () =>
                    value(
                        page,
                        `document.querySelector('.terminal-grid-gpui').contentWindow.fixtureGpui.messages
                    .some(message=>message.presentation?.surface.projection_revision===6 &&
                        message.presentation.surface.frame.cells.slice(0,22).map(cell=>cell.symbol).join('')==='SPACE B NATIVE SURFACE')`,
                    ),
                "the native B surface reaches the real paint bridge, not just the workspace highlight",
            );
            const listingReads = reads.filter((path) => path === "/api/private").length;

            await page.evaluate(`document.dispatchEvent(new Event('visibilitychange'))`);
            await until(
                () => reads.filter((path) => path === "/api/private").length > listingReads,
                "GET hierarchy refresh after workspace navigation",
            );
            assert.equal(
                await value(
                    page,
                    `document.querySelector('.sidebar .private-space-row.active .session-title').textContent`,
                ),
                "pixel-forge",
            );
            assert.deepEqual(
                await value(
                    page,
                    `[...document.querySelectorAll('.private-tabbar button')].map(button => button.textContent)`,
                ),
                ["review"],
                "native B tabstrip wins over the previous opaque route's metadata",
            );
            assert.equal(requests.length, 1, "workspace changes retain one WebSocket/helper");
            await page.click({ selector: ".sidebar .private-space-row:first-of-type" });
            focusedWorkspace = "native-work";
            await project("native-agent", "native-tab", 1);
            await until(focused, "return to workspace A");

            // Same-instance route changes and Chat reuse one native helper/transport.
            await page.evaluate(
                `(await import('/store.js')).navigate(null, {privateId:"opaque-shell"})`,
            );
            await until(
                () =>
                    value(
                        page,
                        `window.fixtureSockets[0].sent.some(frame => frame.method === 'pane.focus' && frame.params.pane_id === 'native-shell')`,
                    ),
                "existing connection focuses the route target",
            );
            assert.equal(requests.length, 1, "pane navigation does not attach another helper");
            await page.evaluate(
                `(await import('/store.js')).navigate(null, {privateId:"opaque-agent"})`,
            );
            await ready(page);
            await click(page, ".private-view-switch button:last-child");
            await present(page, "#private-prompt");
            assert.equal(
                await value(page, "window.fixtureSockets[0].closed"),
                false,
                "Chat keeps its instance connection",
            );
            await until(
                () =>
                    value(
                        page,
                        `window.fixtureSockets[0].sent.filter(frame => frame.method === 'client_shell.surface.set').at(-1)?.params.active === false`,
                    ),
                "Chat pauses native surfaces",
            );
            await click(page, ".private-view-switch button:first-child");
            await ready(page);
            assert.equal(requests.length, 1, "returning to Terminal reuses the connection");

            // An asynchronous paste from the old connection cannot complete into a new epoch.
            await page.evaluate(
                `const canvas = document.createElement('canvas'); canvas.width=2; canvas.height=2; const blob=await new Promise(resolve => canvas.toBlob(resolve,'image/png')); const original=Blob.prototype.arrayBuffer; window.fixtureRestoreBlob=() => {Blob.prototype.arrayBuffer=original}; Blob.prototype.arrayBuffer=function() { if(this.type !== 'image/png') return original.call(this); const file=this; return new Promise(resolve => {window.fixtureReleasePaste=() => original.call(file).then(resolve)}); }; const transfer=new DataTransfer(); transfer.items.add(new File([blob],'delayed.png',{type:'image/png'})); document.querySelector('.terminal-grid-input').dispatchEvent(new ClipboardEvent('paste',{clipboardData:transfer,bubbles:true,cancelable:true}));`,
            );
            await until(
                () => value(page, "typeof window.fixtureReleasePaste === 'function'"),
                "image read is intentionally delayed",
            );
            await page.evaluate(
                `Object.defineProperty(navigator, 'onLine', {configurable:true, value:false}); window.dispatchEvent(new Event('offline'));`,
            );
            await until(
                () =>
                    value(
                        page,
                        `window.fixtureSockets[0].closed && !document.querySelector('.terminal-grid-interaction')`,
                    ),
                "offline drops and clears transport frames",
            );
            await page.evaluate(
                `Object.defineProperty(navigator, 'onLine', {configurable:true, value:true}); window.dispatchEvent(new Event('online'));`,
            );
            await until(
                () => value(page, "window.fixtureSockets.length === 2"),
                "online reconnects automatically with a new ticket",
            );
            assert.equal(requests.length, 2);
            assert.equal(
                await value(page, "window.fixtureSockets[1].sent.length"),
                0,
                "no input sent before a fresh snapshot",
            );
            await frames(page);
            assert.equal(
                await value(
                    page,
                    `window.fixtureSockets[1].sent.some(frame => ['input','popup-input','clipboard-image'].includes(frame.type))`,
                ),
                false,
                "input and paste are never replayed",
            );
            await page.evaluate(
                `window.fixtureRestoreBlob(); await window.fixtureReleasePaste(); await new Promise(resolve => setTimeout(resolve,100));`,
            );
            assert.equal(
                await value(
                    page,
                    `window.fixtureSockets[1].sent.some(frame => frame.type === 'clipboard-image')`,
                ),
                false,
                "an old delayed Blob read cannot paste into a fresh connection with the same boot and pane",
            );

            // Backgrounding closes transport; the fresh connection still requires surface acknowledgement.
            await page.evaluate(
                `window.fixtureHoldInterest = true; Object.defineProperty(document, 'visibilityState', {configurable:true, value:'hidden'}); document.dispatchEvent(new Event('visibilitychange'));`,
            );
            await until(
                () => value(page, `!document.querySelector('.terminal-grid-interaction')`),
                "hidden page stops painting immediately",
            );
            assert.equal(
                await value(page, "window.fixtureSockets[1].closed"),
                true,
                "hidden page releases transport even without pagehide",
            );
            const hiddenReads = reads.length;

            await page.evaluate(
                `window.fixtureSockets[1].receive({type:'surface', surface:window.fixtureSurface}); const input = document.querySelector('.terminal-grid-input'); if(input) { input.value='hidden'; input.dispatchEvent(new InputEvent('input',{bubbles:true,data:'hidden'})); }`,
            );
            await new Promise((resolve) => setTimeout(resolve, 2100));
            assert.equal(reads.length, hiddenReads, "hidden page pauses Private polling");
            assert.equal(
                await value(page, `!!document.querySelector('.terminal-grid-interaction')`),
                false,
                "incoming hidden frames do not paint",
            );
            assert.equal(
                await value(
                    page,
                    `window.fixtureSockets[1].sent.some(frame => frame.type === 'input')`,
                ),
                false,
                "hidden page cannot send new input",
            );
            await page.evaluate(
                `Object.defineProperty(document, 'visibilityState', {configurable:true, value:'visible'}); document.dispatchEvent(new Event('visibilitychange'));`,
            );
            await until(
                () => value(page, "window.fixtureSockets.length === 3"),
                "visible Terminal reconnects with a new ticket",
            );
            await page.evaluate(`const ws = window.fixtureSockets[2];
                ws.receive({type:'connected',welcome:{methods:['client_shell.surface.set']}});
                ws.receive({type:'snapshot',snapshot:${JSON.stringify(snapshot)}});
                ws.receive({type:'surface',surface:window.fixtureSurface});`);
            await page.evaluate(
                `window.fixtureSockets[1].receive({type:'response',requestId:'old',response:{result:{}}}); window.fixtureSockets[2].receive({type:'response',requestId:'unrelated',response:{result:{}}});`,
            );
            assert.equal(
                await value(page, `!!document.querySelector('.terminal-grid-interaction')`),
                false,
                "old and unrelated responses cannot activate the fresh connection",
            );
            assert.equal(
                await value(
                    page,
                    `window.fixtureSockets[2].sent.some(frame => ['input','popup-input','clipboard-image'].includes(frame.type))`,
                ),
                false,
                "returning from background never replays input",
            );
            await page.evaluate(
                `const ws = window.fixtureSockets[2]; const activate = ws.sent.filter(frame => frame.method === 'client_shell.surface.set').at(-1); ws.receive({type:'response',requestId:activate.requestId,response:{result:{}}}); ws.receive({type:'surface',surface:window.fixtureSurface}); window.fixtureHoldInterest=false;`,
            );
            await ready(page);
            assert.equal(requests.length, 3, "return creates one fresh helper");

            await click(page, ".private-disconnect");
            await present(page, ".private-connect");
            await shot(page, "desktop-disconnected");
            await page.evaluate(
                `window.dispatchEvent(new Event('online')); document.dispatchEvent(new Event('visibilitychange'));`,
            );
            await new Promise((resolve) => setTimeout(resolve, 650));
            assert.equal(requests.length, 3, "explicit Disconnect suppresses automatic reconnect");
            await click(page, ".private-connect");
            await until(
                () => value(page, "window.fixtureSockets.length === 4"),
                "explicit Reconnect",
            );
            await frames(page);

            // Import previews once while the existing terminal remains attached.
            await page.evaluate(
                `window.fixtureImportConfirmations = []; window.confirm = message => { window.fixtureImportConfirmations.push(message); return true; };`,
            );
            await click(page, ".sidebar .private-import");
            await until(
                () => requests.some((request) => request.path.endsWith("/import-preview")),
                "import preview with terminal attached",
            );
            assert.equal(await value(page, "window.fixtureSockets[3].closed"), false);
            assert.equal(await value(page, "window.fixtureSockets.length"), 4);
            assert.deepEqual(await value(page, "window.fixtureImportConfirmations"), []);
            assert.equal(
                requests.filter((request) => request.path.endsWith("/terminal")).length,
                4,
                "import neither detaches nor reconnects the terminal",
            );
            assert.equal(
                requests.filter((request) => request.path.endsWith("/import-preview")).length,
                1,
                "preview is not retried",
            );
            await until(
                () =>
                    value(
                        page,
                        `document.querySelector('.private-list-footer').textContent.includes('Synthetic import preview')`,
                    ),
                "import refusal is shown truthfully",
            );
            assert.equal(await value(page, "window.fixtureSockets[3].closed"), false);

            await page.setViewport(VIEWPORTS.mobile);
            await page.navigate(`${base}/private/opaque-agent`);
            await present(page, "#private-prompt");
            const mobileStart = requests.length;

            assert.equal(mobileStart, 5, "mobile agent defaults to Chat without attaching");
            assert.equal(
                await value(page, "document.documentElement.scrollWidth <= innerWidth"),
                true,
            );
            await page.evaluate(`document.querySelector('#private-prompt').focus()`);
            await page.press("Control+b");
            await page.press("c");
            await page.press("Meta+d");
            assert.equal(
                requests.length,
                mobileStart,
                "Chat typing does not attach or dispatch terminal shortcuts",
            );
            await shot(page, "mobile-chat");
            await mockSocket(page);
            await click(page, ".private-view-switch button:first-child");
            await until(
                () => value(page, "window.fixtureSockets.length === 1"),
                "mobile Terminal choice auto-connects",
            );
            await shot(page, "mobile-terminal");

            for (const viewport of [
                { ...VIEWPORTS.tablet, width: 1280, height: 900 },
                VIEWPORTS.mobile,
            ]) {
                await page.setViewport(viewport);
                await frames(page);
                assert.equal(
                    await value(page, 'matchMedia("(pointer: coarse)").matches'),
                    true,
                    "exercise touch input even at desktop-sized tablet widths",
                );
                // Crossing the desktop breakpoint starts the enclosing window's entry
                // animation. Measure resting hit targets, not its transient scale.
                await page.evaluate(`await document.fonts.ready;
                    await Promise.all([...document.querySelectorAll('.private-layout .window')]
                        .flatMap(element=>element.getAnimations())
                        .filter(animation=>Number.isFinite(animation.effect.getComputedTiming().endTime))
                        .map(animation=>animation.finished.catch(()=>{})));
                    await new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve)));`);
                const layout = await value<{
                    checks: Record<string, boolean>;
                    geometry: unknown;
                }>(
                    page,
                    `(() => {
                    const keyboard=document.querySelector('.terminal-keyboard');
                    const nav=document.querySelector('.private-mobile-terminal-nav');
                    const paste=nav?.querySelector('button[aria-label="Paste"]');
                    const r=paste?.getBoundingClientRect();
                    const hit=r && document.elementFromPoint(r.left+r.width/2,r.top+r.height/2);
                    return {
                        checks:{
                            keyboardVisible:!!keyboard && getComputedStyle(keyboard).display==='flex',
                            actionsVisible:!!nav && getComputedStyle(nav).display==='grid',
                            pasteLast:!!paste && nav.lastElementChild===paste,
                            pasteIconOnly:!!paste?.querySelector('svg') && !paste.textContent.trim(),
                            touchWidth:!!r && r.width>=44,
                            touchHeight:!!r && r.height>=44,
                            withinViewport:!!r && r.left>=0 && r.right<=innerWidth &&
                                r.top>=0 && r.bottom<=innerHeight,
                            reachable:!!paste && paste.contains(hit),
                        },
                        geometry:{
                            paste:r?.toJSON(),
                            keyboard:keyboard?.getBoundingClientRect().toJSON(),
                            nav:nav?.getBoundingClientRect().toJSON(),
                            viewport:[innerWidth,innerHeight],
                            hit:hit?.tagName,
                            hitClass:hit?.className,
                        },
                    };
                })()`,
                );

                assert.deepEqual(
                    layout.checks,
                    {
                        keyboardVisible: true,
                        actionsVisible: true,
                        pasteLast: true,
                        pasteIconOnly: true,
                        touchWidth: true,
                        touchHeight: true,
                        withinViewport: true,
                        reachable: true,
                    },
                    `${viewport.width}px touch: keyboard and final Paste icon remain visible and reachable; ${JSON.stringify(layout.geometry)}`,
                );

                if (viewport.width > 960) {
                    await shot(page, "wide-touch-connected");
                }
            }

            await t.test(
                "touch keyboard prefixes survive internal focus but cancel when focus leaves the terminal",
                async () => {
                    const tapKey = async (label: string) => {
                        const result = await page.click({
                            selector: `.terminal-keyboard button[aria-label="${label}"]`,
                        });

                        assert.equal(result.covered, undefined, `${label} is reachable`);
                    };

                    await ready(page);
                    await page.evaluate(`const outside=document.createElement('button');
                        outside.id='fixture-prefix-outside';outside.type='button';
                        outside.textContent='Outside terminal';document.body.append(outside);`);

                    try {
                        for (const focus of ["pointer baseline", "internal", "outside"]) {
                            await page.evaluate(`document.querySelector('.terminal-grid-input').focus({preventScroll:true});
                                window.fixturePrefixStart=window.fixtureSockets[0].sent.length;`);
                            await tapKey("Control");
                            await tapKey("b");
                            await until(
                                () =>
                                    value(
                                        page,
                                        `document.querySelector('.private-terminal-status').textContent
                                    .includes('Herdr prefix: waiting for a key.')`,
                                    ),
                                `${focus}: the UI Ctrl+B arms the native shortcut prefix`,
                            );

                            if (focus !== "pointer baseline") {
                                const selector =
                                    focus === "internal"
                                        ? '.terminal-keyboard button[aria-label="q"]'
                                        : "#fixture-prefix-outside";

                                await page.evaluate(
                                    `document.querySelector(${JSON.stringify(selector)}).focus({preventScroll:true});`,
                                );
                                assert.equal(
                                    await value(
                                        page,
                                        `document.activeElement===document.querySelector(${JSON.stringify(selector)})`,
                                    ),
                                    true,
                                    `${focus}: real DOM focus moves before the chord key`,
                                );
                            }

                            await tapKey("c");
                            assert.deepEqual(
                                await value(
                                    page,
                                    `(() => {
                                    const sent=window.fixtureSockets[0].sent.slice(window.fixturePrefixStart);
                                    return {tabs:sent.filter(frame=>frame.method==='tab.create').length,
                                        inputs:sent.filter(frame=>['input','popup-input','clipboard-image'].includes(frame.type))
                                            .map(frame=>({type:frame.type,pane:frame.paneId,events:frame.events}))};
                                })()`,
                                ),
                                focus === "outside"
                                    ? {
                                          tabs: 0,
                                          inputs: [
                                              {
                                                  type: "input",
                                                  pane: "native-agent",
                                                  events: [{ TextCommit: "c" }],
                                              },
                                          ],
                                      }
                                    : { tabs: 1, inputs: [] },
                                `${focus}: internal focus preserves one shortcut; leaving the root restores ordinary typing`,
                            );
                        }
                    } finally {
                        await page.evaluate(`const outside=document.querySelector('#fixture-prefix-outside');
                            outside?.focus({preventScroll:true});outside?.remove();
                            document.querySelector('.terminal-grid-input')?.focus({preventScroll:true});`);
                    }
                },
            );

            await click(page, '.private-mobile-terminal-nav button[aria-label="Paste"]');
            await present(page, ".terminal-keyboard-paste textarea");
            assert.equal(
                await value(
                    page,
                    "document.activeElement.matches('.terminal-keyboard-paste textarea')",
                ),
                true,
                "the quick-action Paste icon opens the focused paste editor",
            );
            await page.type(undefined, "keep this draft");
            await click(page, '.private-mobile-terminal-nav button[aria-label="Paste"]');
            assert.equal(
                await value(
                    page,
                    "document.querySelector('.terminal-keyboard-paste textarea').value",
                ),
                "keep this draft",
                "pressing Paste again focuses the editor without clearing its draft",
            );
            await click(page, ".terminal-keyboard-paste button:last-child");
            assert.equal(
                await value(
                    page,
                    "document.activeElement.matches('.private-mobile-terminal-nav button[aria-label=Paste]')",
                ),
                true,
                "Cancel returns focus to the relocated Paste icon",
            );
            await click(page, '.private-terminal-footer button[aria-label="Native keyboard"]');
            assert.equal(
                await value(
                    page,
                    "!!document.querySelector('.private-mobile-terminal-nav button[aria-label=Paste]')",
                ),
                false,
                "Paste is hidden in Native mode",
            );
            assert.equal(
                await value(
                    page,
                    "getComputedStyle(document.querySelector('.terminal-keyboard')).display",
                ),
                "none",
                "Native mode does not leave an empty UI keyboard toolbar",
            );
            await click(page, '.private-terminal-footer button[aria-label="Touch keyboard"]');
            assert.equal(
                await value(
                    page,
                    "!!document.querySelector('.private-mobile-terminal-nav button[aria-label=Paste]')",
                ),
                true,
                "the footer selector switches back and restores Paste",
            );
            assert.equal(
                await value(
                    page,
                    `(() => {
                    const footer=document.querySelector('.private-terminal-footer');
                    const group=footer.querySelector('[aria-label="Keyboard type"]');
                    const toggle=footer.querySelector('button[aria-label="Hide keyboard"]');
                    const keyboard=document.querySelector('.terminal-keyboard');
                    const kr=keyboard.getBoundingClientRect(),fr=footer.getBoundingClientRect();
                    return !!group && !!toggle?.querySelector('svg') && kr.bottom<=fr.top+1 &&
                        fr.bottom<=innerHeight+1 && [...group.querySelectorAll('button'),toggle].every(b=>{
                            const r=b.getBoundingClientRect();
                            return r.width>=40 && r.height>=40 && r.left>=0 && r.right<=innerWidth &&
                                b.contains(document.elementFromPoint(r.left+r.width/2,r.top+r.height/2));
                        });
                })()`,
                ),
                true,
                "keyboard type group and chevron remain reachable in the footer below the keys",
            );
            const expandedHeight = await value<number>(
                page,
                "document.querySelector('.terminal-grid-viewport').clientHeight",
            );

            await click(page, '.private-terminal-footer button[aria-label="Hide keyboard"]');
            assert.ok(
                (await value<number>(
                    page,
                    "document.querySelector('.terminal-grid-viewport').clientHeight",
                )) > expandedHeight,
                "footer chevron collapses the touch keyboard, giving space back to the terminal",
            );
            await click(page, '.private-terminal-footer button[aria-label="Show keyboard"]');
            await shot(page, "mobile-connected");
            await click(page, ".private-mobile-terminal-nav button:nth-child(4)");
            assert.equal(
                await value(
                    page,
                    "window.fixtureSockets[0].sent.some(frame => frame.method === 'pane.split')",
                ),
                true,
                "the restored Split quick action still dispatches its native request",
            );
            await click(page, ".private-view-switch button:last-child");
            await present(page, "#private-prompt");
            assert.equal(
                await value(page, "window.fixtureSockets[0].closed"),
                false,
                "mobile Chat retains the transport",
            );
            await click(page, ".private-view-switch button:first-child");
            await ready(page);
            assert.equal(requests.length, mobileStart + 1);
            await page.evaluate(
                `(await import('/store.js')).navigate(null, {privateId:"opaque-shell"})`,
            );
            await present(page, ".private-live-terminal");
            assert.equal(
                await value(page, "!!document.querySelector('#private-prompt')"),
                false,
                "shells have no fake Chat prompt",
            );
            assert.equal(
                requests.length,
                mobileStart + 1,
                "same-instance shell route keeps its connection",
            );

            extraInstances = 4;
            await page.setViewport(VIEWPORTS.desktop);
            await until(
                () =>
                    value(
                        page,
                        `document.querySelectorAll('.sidebar .private-host-label').length === 5`,
                    ),
                "owner hierarchy refresh includes synthetic instances",
            );

            for (let index = 0; index < 4; index++) {
                await page.evaluate(
                    `(await import('/store.js')).navigate(null, {privateId:"extra-pane-${index}"})`,
                );
                await until(
                    () => value(page, `window.fixtureSockets.length === ${index + 2}`),
                    "new instance gets one connection",
                );
                await frames(page);
            }

            assert.equal(
                await value(
                    page,
                    "(await import('/private-terminal.js')).privateTerminalPoolSize()",
                ),
                4,
                "pool is bounded to server cap",
            );
            assert.equal(
                await value(page, "window.fixtureSockets.filter(socket => !socket.closed).length"),
                4,
                "oldest retained instance is evicted",
            );
            assert.equal(await value(page, "window.fixtureSockets[0].closed"), true);
            denied = true;
            await click(page, ".private-disconnect");
            await present(page, ".private-connect");
            await click(page, ".private-connect");
            await until(
                () => value(page, `(await import('/store.js')).store.state.me.role !== 'owner'`),
                "authorization loss",
            );
            assert.equal(
                await value(
                    page,
                    "(await import('/private-terminal.js')).privateTerminalPoolSize()",
                ),
                0,
                "authorization loss clears all pooled private state",
            );
            assert.equal(
                await value(page, "window.fixtureSockets.every(socket => socket.closed)"),
                true,
                "all instances close on authorization loss",
            );
            assert.equal(
                await value(page, "!!document.querySelector('.private-live-terminal')"),
                false,
            );
            assert.equal(await value(page, "!!document.querySelector('.private-tabs')"), false);
        } finally {
            await browsers.closeAll({ final: true });
            server.closeAllConnections();
            await new Promise<void>((resolve) => server.close(() => resolve()));
            await app.close();
        }
    },
);

test(
    "fresh Private route auto-connects through the real gateway and retains its synthetic native child",
    {
        skip: chromium === undefined ? "no Chromium installed" : false,
        timeout: 45_000,
    },
    async () => {
        const directory = mkdtempSync("/tmp/pi-terminal-browser-");
        const endpoint = socketServer();

        await new Promise<void>((resolve) =>
            endpoint.listen(join(directory, "herdr-client.sock"), resolve),
        );
        const app = await openApp(scriptedModel());
        let launches = 0;
        const recorded: Record<string, unknown>[] = [];

        app.piSessions.active.local.sockets = async () => [];

        app.privateTerminals.checkExecutable = async () => {};

        app.privateSessions.terminalTarget = async () => ({
            socket: join(directory, "herdr.sock"),
            pane: "native-agent",
            terminal: "terminal-a",
            instanceId: "local",
        });
        const script = join(directory, "synthetic-client.mjs");

        writeFileSync(
            script,
            `
        import {createInterface} from 'node:readline';
        const send = value => process.stdout.write(JSON.stringify(value)+'\\n');
        send({type:'connected',welcome:{generation:1,methods:['pane.focus','client_shell.surface.set']}});
        send({type:'snapshot',snapshot:${JSON.stringify(snapshot)}});
        send({type:'surface',surface:${JSON.stringify(surface())}});
        const reader = createInterface({input:process.stdin,crlfDelay:Infinity});
        reader.on('line',line => {
            const command = JSON.parse(line);
            send({type:'message',message:{recorded:command}});
            if (command.method === 'client_shell.surface.set') {
                send({type:'response',requestId:command.requestId,response:{result:{}}});
                if (command.params.active) send({type:'surface',surface:${JSON.stringify(surface())}});
            }
        });
        reader.on('close',() => process.exit(0));
    `,
        );

        app.privateTerminals.launch = (socket) => {
            assert.equal(socket, join(directory, "herdr-client.sock"));
            launches++;
            const child = spawn(process.execPath, [script], { stdio: ["pipe", "pipe", "pipe"] });
            let buffered = "";

            child.stdout.on("data", (chunk) => {
                buffered += String(chunk);
                let newline;

                while ((newline = buffered.indexOf("\n")) >= 0) {
                    const event = JSON.parse(buffered.slice(0, newline));

                    buffered = buffered.slice(newline + 1);

                    if (event.message?.recorded) {
                        recorded.push(event.message.recorded);
                    }
                }
            });

            return child;
        };

        const handler = createHandler({
            app,
            listen: { host: "127.0.0.1", port: 0 },
            restart: () => {},
        });
        const pane = {
            id: "opaque-real",
            nativeId: "native-agent",
            supportsImport: false,
            title: "Synthetic Pi",
            cwd: "/fixture",
            agent: "pi",
            state: "idle",
        };
        const server = createServer((request, response) => {
            if (request.url === "/herdr-renderer/build.json") {
                response.setHeader("Content-Type", "application/json");
                response.end(JSON.stringify(gpuiFixture.manifest));

                return;
            }

            if (request.url === gpuiFixture.wasmPath) {
                response.setHeader("Content-Type", "application/wasm");
                response.end(gpuiFixture.wasm);

                return;
            }

            if (request.url === `/herdr-renderer/${gpuiFixture.entry}`) {
                response.setHeader("Content-Type", "text/html");
                response.end(gpuiFixture.html);

                return;
            }

            if (request.url === "/api/private" && request.method === "GET") {
                response.setHeader("Content-Type", "application/json");
                response.end(
                    JSON.stringify({
                        warnings: [],
                        instances: [
                            {
                                id: "local",
                                label: "Fixture",
                                available: true,
                                workspaces: [
                                    {
                                        id: "w",
                                        nativeId: "native-work",
                                        label: "Fixture",
                                        tabs: [
                                            {
                                                id: "t",
                                                nativeId: "native-tab",
                                                label: "editor",
                                                panes: [pane],
                                            },
                                        ],
                                    },
                                ],
                            },
                        ],
                    }),
                );

                return;
            }

            if (request.url === "/api/private/opaque-real" && request.method === "GET") {
                response.setHeader("Content-Type", "application/json");
                response.end(
                    JSON.stringify({
                        pane,
                        revision: "fixture",
                        capturedAt: Date.now(),
                        terminal: "SYNTHETIC_NATIVE_CHILD",
                        entries: [],
                        canImport: false,
                        canPrompt: false,
                        warnings: [],
                    }),
                );

                return;
            }

            return handler(request, response);
        });

        server.on("upgrade", app.privateTerminals.upgrade);
        await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
        const base = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
        const browsers = new Browsers({
            dataDir: join(root, "private-terminal-real-browser"),
            load: async () => undefined,
            save: () => {},
        });

        try {
            const page = await browsers.open(1);

            await page.setViewport(VIEWPORTS.desktop);
            await page.navigate(`${base}/login?token=${encodeURIComponent(app.config.ownerToken)}`);
            await present(page, ".private-tabs");
            await page.navigate(`${base}/private/opaque-real`);
            await ready(page);
            assert.equal(
                launches,
                1,
                "fresh Terminal route automatically launches one native client",
            );
            await until(
                () => recorded.some((command) => command.type === "resize"),
                "browser geometry reaches native child",
            );
            assert.equal(launches, 1);
            assert.ok(
                recorded.some((command) => command.method === "pane.focus"),
                "gateway focuses the owner-authorized opaque target on opening Terminal",
            );
            assert.ok(recorded.every((command) => command.bootId === "fixture-boot"));
            assert.equal(
                await value(
                    page,
                    `document.activeElement?.getAttribute('aria-label') === 'Terminal input'`,
                ),
                true,
                "fresh desktop Terminal is focused after the first acknowledged surface",
            );
            await click(page, ".private-view-switch button:last-child");
            await present(page, ".private-transcript");
            await until(
                () =>
                    recorded.some(
                        (command) =>
                            command.method === "client_shell.surface.set" &&
                            (command.params as { active: boolean }).active === false,
                    ),
                "real gateway pauses surfaces in Chat",
            );
            await click(page, ".private-view-switch button:first-child");
            await ready(page);
            assert.equal(launches, 1, "Chat reactivation keeps the native helper");
            await click(page, ".private-disconnect");
            await present(page, ".private-connect:not(:disabled)");
            assert.equal(
                await value(page, "!!document.querySelector('.terminal-grid-interaction')"),
                false,
            );
            await new Promise((resolve) => setTimeout(resolve, 650));
            assert.equal(launches, 1, "Disconnect suppresses background reconnect");
            await page.reload();
            await ready(page);
            assert.equal(launches, 2, "reopening a fresh Terminal route reconnects");
            await page.evaluate(`window.dispatchEvent(new Event('pagehide'))`);
            await present(page, ".private-connect:not(:disabled)");
            assert.equal(
                await value(page, "!!document.querySelector('.terminal-grid-interaction')"),
                false,
                "pagehide closes and clears transport",
            );
            assert.deepEqual(
                page.logs().filter((entry) => entry.level === "error"),
                [],
            );
        } finally {
            await browsers.closeAll({ final: true });
            await app.close();
            server.closeAllConnections();
            await new Promise<void>((resolve) => server.close(() => resolve()));
            await new Promise<void>((resolve) => endpoint.close(() => resolve()));
            rmSync(directory, { recursive: true, force: true });
        }
    },
);
