// Real Chromium against a throwaway app. Herdr and imports are HTTP fixtures, never live discovery.
import { cleanUp, newSession, openApp, root, say, scriptedModel, until } from "./helpers.ts";
import assert from "node:assert/strict";
import { mkdirSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import { join } from "node:path";
import { after, test } from "node:test";
import { Browsers } from "../src/server/browser.ts";
import { findBrowser } from "../src/server/browser/discovery.ts";
import type { BrowserPage } from "../src/server/browser/page.ts";
import { VIEWPORTS } from "../src/server/browser/viewport.ts";
import { createHandler } from "../src/server/http.ts";

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
    const directory = process.env.PRIVATE_SCREENSHOT_DIR;

    if (directory) {
        mkdirSync(directory, { recursive: true });
        await page.evaluate(`
            await Promise.all(document.getAnimations()
                .filter(animation => Number.isFinite(animation.effect.getComputedTiming().endTime))
                .map(animation => animation.finished.catch(() => {})));
            await new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)));
        `);
        const captured = await page.screenshot();

        writeFileSync(join(directory, `${name}.jpg`), Buffer.from(captured.data, "base64"));
    }
}

/** Compare the visible Chat presentation against a real Durable conversation, not CSS source. */
async function chatAppearance(page: BrowserPage) {
    return value(
        page,
        `(() => {
        const parts = {
            transcript: ['.transcript', ['max-width', 'padding', 'gap']],
            footer: ['footer.composer-wrap', ['max-width', 'padding']],
            bubble: ['.user-row .bubble', ['max-width', 'border-radius', 'padding', 'background-color']],
            box: ['.composer', ['border', 'border-radius', 'padding']],
            input: ['.composer textarea', ['font-family', 'font-size', 'line-height', 'padding', 'max-height', 'resize', 'background-color']],
            send: ['.round.send', ['width', 'height', 'border-radius']],
        };
        return {
            ...Object.fromEntries(Object.entries(parts).map(([name, [selector, properties]]) => {
                const style = getComputedStyle(document.querySelector(selector));
                return [name, Object.fromEntries(properties.map(property => [property, style.getPropertyValue(property)]))];
            })),
            sendIcon: document.querySelector('.round.send svg').innerHTML,
        };
    })()`,
    );
}

/** The outer windows must honor Appearance, regardless of which session type is open. */
async function windowAppearance(page: BrowserPage) {
    return value(
        page,
        `(() => {
            const layout = getComputedStyle(document.querySelector('.layout'));
            return {
                padding: layout.padding,
                gap: layout.gap,
                borders: ['.sidebar', '.pane'].map(selector => {
                    const style = getComputedStyle(document.querySelector(selector));
                    return [style.borderTopWidth, style.borderRightWidth, style.borderBottomWidth, style.borderLeftWidth];
                }),
            };
        })()`,
    );
}

test(
    "Private mirror: shared read-only Chat, lazy owner-only tree, guarded prompt and explicit shared import",
    {
        skip: chromium === undefined ? "no Chromium installed" : false,
        timeout: 90_000,
    },
    async () => {
        const app = await openApp(scriptedModel());

        app.imports.active.local.sockets = async () => [];
        const durableId = await newSession(app);

        await say(app, durableId, "Durable style reference");
        const handler = createHandler({
            app,
            listen: { host: "127.0.0.1", port: 0 },
            restart: () => {},
        });
        const paneId = "opaque:/pi?one";
        const shellId = "opaque-shell";
        let revision = "session-a";
        let promptStatus = 200;
        let promptReply: Promise<void> | null = null;
        let quarantined = false;
        let detailDelay = 0;
        let detailStatus = 200;
        let historyRows = 20;
        const requests: { path: string; method: string; body: Record<string, unknown> }[] = [];
        const durableRequests: { path: string; method: string }[] = [];
        const inFlight = new Map<string, number>();
        let overlap = false;
        const overlaps: string[] = [];
        const preview = {
            activeId: "active-opaque",
            title: "Fixture Pi",
            cwd: "/fixture/work",
            location: "Herdr / work / tab",
            path: "/fixture/session.jsonl",
            sha256: "fixture-hash",
            leafId: "last",
            entries: 3,
            messages: 2,
            hasImages: false,
            sourceModel: { provider: "faux", modelId: "faux-1" },
            sourceThinkingLevel: "off",
            models: [{ provider: "faux", id: "faux-1", levels: ["off"], images: false }],
            warnings: [],
        };
        const server = createServer(async (request, response) => {
            const path = new URL(request.url!, "http://fixture").pathname;

            if (path.startsWith("/api/c/")) {
                durableRequests.push({ path, method: request.method! });
            }

            if (
                !path.startsWith("/api/private") &&
                path !== "/api/imports/active" &&
                path !== "/api/imports/active/preview"
            ) {
                return handler(request, response);
            }

            let raw = "";

            for await (const chunk of request) {
                raw += chunk;
            }

            const body = raw ? (JSON.parse(raw) as Record<string, unknown>) : {};

            requests.push({ path, method: request.method!, body });
            response.setHeader("Content-Type", "application/json");
            response.setHeader("Cache-Control", "no-store");

            if (path === "/api/private") {
                response.end(
                    JSON.stringify({
                        warnings: [],
                        instances: [
                            {
                                id: "herdr-a",
                                label: "Local Herdr",
                                available: true,
                                workspaces: [
                                    {
                                        id: "work-child",
                                        label: "short directory name",
                                        branch: "feature/68953-data-extract-notifications-with-a-long-name",
                                        worktree: {
                                            key: "repo-a",
                                            label: "Pocket work",
                                            isLinkedWorktree: true,
                                        },
                                        tabs: [],
                                    },
                                    {
                                        id: "work-a",
                                        label: "Pocket work",
                                        branch: "main",
                                        worktree: {
                                            key: "repo-a",
                                            label: "Pocket work",
                                            isLinkedWorktree: false,
                                        },
                                        tabs: [
                                            {
                                                id: "tab-a",
                                                label: "Main tab",
                                                panes: [
                                                    {
                                                        id: paneId,
                                                        title: "Fixture Pi",
                                                        cwd: "/fixture/work",
                                                        agent: "pi",
                                                        state: "idle",
                                                    },
                                                    {
                                                        id: shellId,
                                                        title: "Fixture shell",
                                                        cwd: "/fixture/work",
                                                        state: "shell",
                                                    },
                                                ],
                                            },
                                        ],
                                    },
                                    {
                                        id: "work-custom",
                                        label: "Named review",
                                        customLabel: true,
                                        branch: "feature/review",
                                        worktree: {
                                            key: "repo-a",
                                            label: "Pocket work",
                                            isLinkedWorktree: true,
                                        },
                                        tabs: [],
                                    },
                                    {
                                        id: "work-orphan",
                                        label: "feature/orphan",
                                        worktree: {
                                            key: "no-parent",
                                            label: "Orphan repo",
                                            isLinkedWorktree: true,
                                        },
                                        tabs: [],
                                    },
                                    { id: "work-plain", label: "feature/not-a-worktree", tabs: [] },
                                ],
                            },
                            {
                                id: "herdr-b",
                                label: "Sleeping Herdr",
                                available: false,
                                error: "Socket unavailable",
                                workspaces: [],
                            },
                            {
                                id: "herdr-c",
                                label: "Empty Herdr",
                                available: true,
                                workspaces: [],
                            },
                        ],
                    }),
                );

                return;
            }

            if (path.endsWith("/terminal")) {
                response.statusCode = 503;
                response.end(JSON.stringify({ error: "Synthetic fixture has no terminal client" }));

                return;
            }

            if (path.endsWith("/prompt")) {
                response.statusCode = promptStatus;
                quarantined ||= promptStatus === 503;
                await promptReply;
                response.end(
                    JSON.stringify(
                        promptStatus === 200 ? { sent: true } : { error: "uncertain fixture" },
                    ),
                );

                return;
            }

            if (path.endsWith("/import-preview")) {
                response.end(JSON.stringify(preview));

                return;
            }

            if (path === "/api/imports/active/preview") {
                response.end(JSON.stringify({ ...preview, visibility: "shared" }));

                return;
            }

            if (path === "/api/imports/active" && request.method === "GET") {
                response.end(
                    JSON.stringify({
                        sessions: [
                            {
                                id: "recovered-shared",
                                title: "Recovered shared move",
                                cwd: preview.cwd,
                                location: preview.location,
                                state: "stopped",
                                recovery: true,
                            },
                        ],
                        warnings: [],
                    }),
                );

                return;
            }

            if (path === "/api/imports/active") {
                response.end(JSON.stringify({ id: durableId, existing: false }));

                return;
            }

            if (detailStatus !== 200) {
                response.statusCode = detailStatus;
                response.end(JSON.stringify({ error: "Snapshot unavailable fixture" }));

                return;
            }

            const count = (inFlight.get(path) ?? 0) + 1;

            inFlight.set(path, count);
            overlap ||= count > 1;

            if (count > 1) {
                overlaps.push(`${path} (delay ${detailDelay}, count ${count})`);
            }

            const shell = decodeURIComponent(path.split("/").at(-1)!) === shellId;
            const snapshot = {
                pane: {
                    id: shell ? shellId : paneId,
                    title: shell ? "Fixture shell" : "Fixture Pi",
                    cwd: "/fixture/work",
                    state: shell ? "shell" : "idle",
                    ...(shell ? {} : { agent: "pi" }),
                },
                revision,
                capturedAt: Date.now(),
                warnings: [],
                canPrompt: !shell && !quarantined,
                canImport: !shell && !quarantined,
                reason: quarantined
                    ? "Check Herdr and restart the app before sending or importing."
                    : shell
                      ? "Shell panes are read-only."
                      : undefined,
                terminal: shell
                    ? "SHELL_ONLY_OUTPUT"
                    : `${Array.from({ length: 200 }, (_, index) => `terminal line ${index}`).join("\n")}\nLIVE_PRIVATE_OUTPUT ${historyRows}`,
                entries: shell
                    ? []
                    : [
                          {
                              id: 1,
                              kind: "user",
                              text: "PRIVATE_SAVED_MESSAGE @src/file.ts",
                              files: ["src/attached.ts"],
                              images: 1,
                          },
                          {
                              id: 2,
                              kind: "assistant",
                              stopReason: "stop",
                              blocks: [
                                  { type: "thinking", text: "PRIVATE_SAVED_THOUGHT" },
                                  {
                                      type: "text",
                                      text: "Saved **answer**. `src/file.ts`\n\n![private](/api/c/1/file?path=secret)\n\n```html\n<h1>Do not run</h1>\n```",
                                  },
                                  {
                                      type: "toolCall",
                                      id: "tool-a",
                                      name: "read",
                                      args: { path: "file.ts" },
                                  },
                              ],
                          },
                          {
                              id: 3,
                              kind: "toolResult",
                              name: "read",
                              text: "PRIVATE_TOOL_RESULT",
                              callId: "tool-a",
                              isError: false,
                              clipped: true,
                              images: 1,
                          },
                          ...Array.from({ length: historyRows }, (_, index) => ({
                              id: index + 4,
                              kind: "user",
                              text: `Saved row ${index}\n\nA longer history for scrolling checks.`,
                              images: 0,
                          })),
                      ],
            };

            await new Promise((resolve) => setTimeout(resolve, detailDelay));
            inFlight.set(path, count - 1);
            response.end(JSON.stringify(snapshot));
        });
        const browsers = new Browsers({
            dataDir: join(root, "private-ui-browser"),
            load: async () => undefined,
            save: () => {},
        });

        await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
        const base = `http://127.0.0.1:${(server.address() as { port: number }).port}`;

        try {
            const page = await browsers.open(1);

            await page.setViewport(VIEWPORTS.mobile);
            await page.navigate(`${base}/login?token=${encodeURIComponent(app.config.ownerToken)}`);
            await present(page, ".home-list .private-tabs");
            assert.equal(requests.length, 0, "Private is not fetched on Sessions");
            await page.evaluate(`(await import('/store.js')).navigate(${durableId})`);
            await present(page, ".user-row .bubble");
            await present(page, ".round.send svg");
            const mobileAppearance = await chatAppearance(page);

            await page.setViewport(VIEWPORTS.desktop);
            const desktopAppearance = await chatAppearance(page);
            const tiledWindows = {
                padding: "10px",
                gap: "10px",
                borders: Array.from({ length: 2 }, () => ["2px", "2px", "2px", "2px"]),
            };

            assert.deepEqual(await windowAppearance(page), tiledWindows, "shared tiled windows");

            await page.setViewport(VIEWPORTS.mobile);
            await page.evaluate(`(await import('/store.js')).navigate(null)`);
            await present(page, ".home-list .private-tabs");
            durableRequests.length = 0;
            await page.click({ selector: ".home-list .private-tabs button:last-child" });
            await present(page, ".home-list .private-pane-row");
            assert.match(
                await value<string>(page, `document.querySelector('.home-list').textContent`),
                /Spaces[\s\S]*Local Herdr[\s\S]*Pocket work[\s\S]*Agents[\s\S]*Pocket work[\s\S]*Main tab[\s\S]*pi · idle/,
            );
            assert.match(
                await value<string>(page, `document.querySelector('.home-list').textContent`),
                /Unavailable[\s\S]*No workspaces/,
            );
            assert.deepEqual(
                await value(
                    page,
                    `[...document.querySelectorAll('.home-list .private-space-row .session-title')].map(row => row.textContent)`,
                ),
                [
                    "Pocket work",
                    "feature/68953-data-extract-notifications-with-a-long-name",
                    "Named review",
                    "feature/orphan",
                    "feature/not-a-worktree",
                ],
                "repo roots precede their linked checkouts; branch prefixes and custom labels survive",
            );
            assert.equal(
                await value(
                    page,
                    `document.querySelectorAll('.home-list .private-worktree-children .private-space-row').length`,
                ),
                2,
                "only daemon-linked children with an open parent nest",
            );
            assert.equal(
                await value(page, "document.documentElement.scrollWidth <= innerWidth"),
                true,
            );
            const beforeFold = requests.length;

            await click(page, ".home-list .private-worktree-toggle");
            assert.equal(
                await value(
                    page,
                    `document.querySelector('.home-list .private-worktree-toggle').getAttribute('aria-expanded')`,
                ),
                "false",
            );
            assert.equal(
                await value(
                    page,
                    `document.querySelectorAll('.home-list .private-space-row').length`,
                ),
                3,
            );
            assert.equal(
                requests.length,
                beforeFold,
                "folding is local, without terminal focus or input",
            );
            await click(page, ".home-list .private-worktree-toggle");
            assert.equal(
                await value(
                    page,
                    `document.querySelectorAll('.home-list .private-space-row').length`,
                ),
                5,
            );
            await shot(page, "mobile-tree");
            await click(page, ".home-list .private-pane-row");
            await present(page, "#private-prompt");
            // Exercise the server's SPA fallback too, not just client-side route changes.
            await page.navigate(`${base}/private/${encodeURIComponent(paneId)}`);
            await present(page, "#private-prompt");
            await page.evaluate(
                `const field = document.querySelector('#private-prompt'); field.value = 'Do not persist private drafts'; field.dispatchEvent(new Event('input', { bubbles: true }));`,
            );
            assert.equal(
                await value(
                    page,
                    `[localStorage, sessionStorage].every(storage => !Object.values(storage).some(value => /Do not persist private drafts|PRIVATE_SAVED_MESSAGE|PRIVATE_TOOL_RESULT|PRIVATE_SAVED_THOUGHT/.test(value)))`,
                ),
                true,
                "private drafts and saved history stay out of browser storage",
            );
            await page.reload();
            await present(page, "#private-prompt");
            assert.equal(
                await value(page, `document.querySelector('#private-prompt').value`),
                "",
                "private drafts are not persisted",
            );
            assert.equal(
                await value(page, "location.pathname"),
                `/private/${encodeURIComponent(paneId)}`,
            );
            assert.equal(
                await value(
                    page,
                    `!!document.querySelector('.private-transcript .user-row .bubble')`,
                ),
                true,
                "saved user messages use the Durable bubble layout",
            );
            assert.equal(
                await value(page, `document.querySelector('.private-terminal').open`),
                false,
                "Chat opens with its read-only terminal snapshot collapsed",
            );
            assert.deepEqual(
                await chatAppearance(page),
                mobileAppearance,
                "mobile private Chat shares Durable widths, bubbles, composer styling and arrow Send",
            );
            await page.setViewport(VIEWPORTS.desktop);
            await present(page, ".private-view-switch");
            assert.deepEqual(
                await windowAppearance(page),
                tiledWindows,
                "private sessions honor tiled gaps and both window borders",
            );

            for (const focused of ["sidebar", "pane"]) {
                await page.hover({ selector: `.${focused}` });
                await until(
                    () =>
                        value(
                            page,
                            `getComputedStyle(document.querySelector('.${focused}'), '::after').opacity === '1'`,
                        ),
                    `private ${focused} active border`,
                );
                assert.equal(
                    await value(
                        page,
                        `getComputedStyle(document.querySelector('.${focused}'), '::after').borderTopWidth`,
                    ),
                    "2px",
                );
            }

            await shot(page, "desktop-terminal");
            await page.evaluate(`(await import('/theme.js')).setPrefs({ tiling: false })`);
            assert.deepEqual(
                await windowAppearance(page),
                {
                    padding: "0px",
                    gap: "normal",
                    borders: [
                        ["0px", "1px", "0px", "0px"],
                        ["0px", "0px", "0px", "0px"],
                    ],
                },
                "private sessions still support flat layout",
            );
            await page.evaluate(`(await import('/theme.js')).setPrefs({ tiling: true })`);
            assert.deepEqual(await windowAppearance(page), tiledWindows, "tiling can be restored");
            await page.setViewport(VIEWPORTS.mobile);
            await click(page, ".private-view-switch button:last-child");
            await present(page, "#private-prompt");
            assert.equal(
                await value(
                    page,
                    `document.querySelector('#private-prompt').form.matches('footer.composer-wrap > form.private-composer')`,
                ),
                true,
                "the private prompt remains a form inside the shared composer footer",
            );
            assert.equal(
                await value(
                    page,
                    `document.querySelector('.private-composer button[type=submit]').getAttribute('aria-label')`,
                ),
                "Send to Pi",
            );
            await click(page, ".private-terminal summary");
            const nearBottom = `['.private-transcript', '.private-terminal pre'].every(selector => { const box = document.querySelector(selector); return box.scrollHeight - box.clientHeight - box.scrollTop < 3; })`;

            await until(() => value(page, nearBottom), "initial latest message and terminal tail");
            historyRows++;
            await until(
                () => value(page, `document.body.textContent.includes('Saved row 20')`),
                "new saved message",
            );
            assert.equal(await value(page, nearBottom), true, "follows from the bottom");
            await page.evaluate(
                `for (const selector of ['.private-transcript', '.private-terminal pre']) { const box = document.querySelector(selector); box.scrollTop = 0; box.dispatchEvent(new Event('scroll')); }`,
            );
            historyRows++;
            await until(
                () => value(page, `document.body.textContent.includes('Saved row 21')`),
                "polled while reading history",
            );
            assert.equal(
                await value(
                    page,
                    `['.private-transcript', '.private-terminal pre'].every(selector => document.querySelector(selector).scrollTop === 0)`,
                ),
                true,
                "manual scroll is preserved",
            );
            assert.equal(
                await value(page, `(await import('/store.js')).store.state.conversationId`),
                null,
            );
            assert.equal(
                await value(page, `(await import('/store.js')).store.state.view.entries.size`),
                0,
            );
            assert.equal(
                await value(
                    page,
                    `document.querySelectorAll('.private-transcript img, .private-transcript [data-path], .private-transcript .rich, .private-transcript iframe, .pane [aria-label="People"], .pane [aria-label="Files"]').length`,
                ),
                0,
            );
            assert.equal(
                await value(page, "document.documentElement.scrollWidth <= innerWidth"),
                true,
            );
            await page.evaluate(
                `[...document.querySelectorAll('.private-transcript code')].find(code => code.textContent === 'src/file.ts').click()`,
            );
            assert.equal(
                await value(page, `(await import('/store.js')).store.state.sheet`),
                null,
                "private paths do not open Durable files",
            );
            await click(page, ".private-transcript .user-row .bubble");
            assert.equal(
                await value(page, `(await import('/store.js')).store.state.sheet`),
                null,
                "private user bubbles do not open edit, resend or fork actions",
            );
            assert.equal(
                await value(
                    page,
                    `document.querySelectorAll('.private-transcript .tool-head').length`,
                ),
                1,
                "a saved tool call and its result form one card, not separate rows",
            );
            assert.equal(
                await value(page, `!!document.querySelector('.private-transcript .tool-body')`),
                false,
                "tool details start collapsed",
            );
            await click(page, ".private-transcript .tool-head");
            await present(page, ".private-transcript .tool-body");
            assert.equal(
                await value(
                    page,
                    `document.querySelector('.private-transcript .tool-body pre').textContent`,
                ),
                "PRIVATE_TOOL_RESULT",
                "expanding the call reveals its associated saved result",
            );
            assert.match(
                await value<string>(
                    page,
                    `document.querySelector('.private-transcript .tool-body').textContent`,
                ),
                /clipped/i,
                "clipped results stay bounded snapshots instead of loading Durable entries",
            );
            assert.equal(
                await value(page, `!!document.querySelector('.private-transcript .thought-body')`),
                false,
                "saved thinking starts collapsed",
            );
            await click(page, ".private-transcript .thought-head");
            assert.equal(
                await value(
                    page,
                    `document.querySelector('.private-transcript .thought-body').textContent`,
                ),
                "PRIVATE_SAVED_THOUGHT",
                "saved thinking can be read locally",
            );
            // Copy, thought expansion and tool expansion are local controls, not Durable actions.
            assert.deepEqual(
                await value(
                    page,
                    `[...document.querySelectorAll('.private-transcript button')].filter(button => !button.matches('.tool-head, .thought-head') && button.textContent.trim() !== 'Copy').map(button => button.getAttribute('aria-label') || button.textContent.trim())`,
                ),
                [],
                "no file, rich Run, full-entry load, reaction, retry, pin, discuss or fork controls",
            );
            await click(page, ".private-transcript .tool-head");
            assert.equal(
                await value(page, `!!document.querySelector('.private-transcript .tool-body')`),
                false,
            );
            await click(page, ".private-transcript .thought-head");
            assert.equal(
                await value(page, `!!document.querySelector('.private-transcript .thought-body')`),
                false,
            );
            await click(page, ".private-terminal summary");
            assert.equal(
                await value(page, `document.querySelector('.private-terminal').open`),
                false,
            );
            await page.evaluate(`document.querySelector('.private-transcript').scrollTop = 0`);
            await shot(page, "mobile-chat");
            await page.evaluate(`(await import('/store.js')).store.set({ drawer: true })`);
            await present(page, ".drawer .private-pane-row");
            await until(
                () => value(page, `history.state?.pocket?.layers === 1`),
                "drawer history entry",
            );
            await page.evaluate(`(await import('/back.js')).goBack()`);
            await until(
                () => value(page, `!(await import('/store.js')).store.state.drawer`),
                "drawer back",
            );
            await page.go(-1, { wait: false });
            await until(
                () =>
                    value(
                        page,
                        `location.pathname === '/' && !!document.querySelector('.home-list .private-pane-row')`,
                    ),
                "back to private list",
            );
            await page.go(1, { wait: false });
            await present(page, "#private-prompt");
            await page.setViewport(VIEWPORTS.desktop);
            await page.evaluate(`(await import('/theme.js')).setPrefs({ sidebar: 'rail' })`);
            await present(page, '.rail [aria-label="Private Herdr panes"]');
            await click(page, '.rail [aria-label="Private Herdr panes"]');
            await present(page, ".sidebar .private-pane-row");
            await click(page, ".private-view-switch button:last-child");
            await present(page, "#private-prompt");
            assert.deepEqual(
                await chatAppearance(page),
                desktopAppearance,
                "desktop private Chat shares Durable widths and composer presentation",
            );
            assert.deepEqual(
                await windowAppearance(page),
                tiledWindows,
                "private Chat tiled windows",
            );
            assert.equal(
                await value(page, `document.querySelector('.private-terminal').open`),
                false,
                "reopening Chat keeps the snapshot collapsed",
            );
            await page.evaluate(`document.querySelector('.private-transcript').scrollTop = 0`);
            await shot(page, "desktop-chat");
            assert.equal(
                await value(page, "document.documentElement.scrollWidth <= innerWidth"),
                true,
            );

            assert.equal(await value(page, `matchMedia('(pointer: coarse)').matches`), false);
            await page.type({ selector: "#private-prompt" }, "Keep this draft");
            await page.press("Shift+Enter");
            assert.equal(
                await value(page, `document.querySelector('#private-prompt').value`),
                "Keep this draft\n",
                "Shift+Enter inserts a newline without sending",
            );
            assert.equal(requests.filter((item) => item.path.endsWith("/prompt")).length, 0);
            await page.type({ selector: "#private-prompt" }, "Keep this draft");
            revision = "session-b";
            await until(
                () =>
                    value(
                        page,
                        `document.body.textContent.includes('The Pi session in this pane changed')`,
                    ),
                "stale revision",
            );
            await page.press("Enter");
            await page.evaluate(`document.querySelector('.private-composer').requestSubmit()`);
            assert.equal(
                requests.filter((item) => item.path.endsWith("/prompt")).length,
                0,
                "both desktop Enter and form submission respect the stale-session guard",
            );
            assert.equal(
                await value(page, `document.querySelector('#private-prompt').value`),
                "Keep this draft",
            );
            await page.evaluate(
                `[...document.querySelectorAll('.private-composer button')].find(button => button.textContent.includes('Use draft')).click()`,
            );
            promptStatus = 409;
            await page.click({ selector: "#private-prompt" });
            await page.press("Enter");
            await until(
                () =>
                    value(page, `document.body.textContent.includes('pane changed or Pi is busy')`),
                "busy prompt rejection",
            );
            assert.equal(
                await value(page, `document.querySelector('#private-prompt').value`),
                "Keep this draft",
            );
            promptStatus = 503;
            await page.click({ selector: "#private-prompt" });
            await page.press("Enter");
            await until(
                () => value(page, `document.body.textContent.includes('Delivery is uncertain')`),
                "uncertain delivery",
            );
            assert.equal(requests.filter((item) => item.path.endsWith("/prompt")).length, 2);
            assert.equal(
                await value(page, `document.querySelector('#private-prompt').value`),
                "Keep this draft",
                "uncertain delivery also retains the in-memory draft",
            );
            assert.equal(
                requests.find((item) => item.path.endsWith("/prompt"))?.body.revision,
                "session-b",
            );
            await page.evaluate(`document.querySelector('.private-composer').requestSubmit()`);
            await new Promise((resolve) => setTimeout(resolve, 2300));
            assert.equal(
                requests.filter((item) => item.path.endsWith("/prompt")).length,
                2,
                "no automatic or accidental retry",
            );
            assert.equal(
                await value(page, `document.querySelector('.sidebar .private-import').disabled`),
                true,
                "uncertain input also blocks import",
            );
            assert.match(
                await value<string>(
                    page,
                    `document.querySelector('.private-composer').textContent`,
                ),
                /Import stays blocked until delivery is resolved[\s\S]*not be retried automatically/,
            );
            // Synthetic restart: a new epoch/revision and cleared server quarantine, never a real restart.
            quarantined = false;
            revision = "session-after-restart";
            await until(
                () =>
                    value(
                        page,
                        `document.body.textContent.includes('The Pi session in this pane changed')`,
                    ),
                "restart invalidates old draft revision",
            );
            await page.evaluate(
                `[...document.querySelectorAll('.private-composer button')].find(button => button.textContent.includes('Use draft')).click()`,
            );
            await until(
                () =>
                    value(
                        page,
                        `!document.querySelector('.private-composer button[type=submit]').disabled`,
                    ),
                "explicit draft review after restart",
            );
            promptStatus = 200;

            let acknowledge = () => {};

            promptReply = new Promise<void>((resolve) => {
                acknowledge = resolve;
            });
            await page.click({ selector: "#private-prompt" });
            const sending = page.press("Enter");

            try {
                await until(
                    () => requests.filter((item) => item.path.endsWith("/prompt")).length === 3,
                    "desktop Enter reaches the guarded private endpoint",
                );
                await until(
                    () => value(page, `document.querySelector('#private-prompt').disabled`),
                    "pending private delivery disables the composer",
                );
                assert.equal(
                    await value(page, `document.querySelector('#private-prompt').value`),
                    "Keep this draft",
                    "dispatch alone never clears a private draft",
                );
                await page.evaluate(`document.querySelector('.private-composer').requestSubmit()`);
                assert.equal(
                    requests.filter((item) => item.path.endsWith("/prompt")).length,
                    3,
                    "pending input is not duplicated by form submission",
                );
            } finally {
                acknowledge();
                promptReply = null;
            }

            await sending;
            await until(
                () => value(page, `document.querySelector('#private-prompt').value === ''`),
                "successful prompt",
            );
            const prompts = requests.filter((item) => item.path.endsWith("/prompt"));

            assert.equal(prompts.length, 3);
            assert.equal(new Set(prompts.map((item) => item.body.requestId)).size, 3);
            assert.deepEqual(
                prompts.map((item) => ({
                    path: item.path,
                    method: item.method,
                    text: item.body.text,
                })),
                Array.from({ length: 3 }, () => ({
                    path: `/api/private/${encodeURIComponent(paneId)}/prompt`,
                    method: "POST",
                    text: "Keep this draft",
                })),
                "desktop Enter sends only to the selected private Pi, never Durable",
            );
            assert.equal(prompts.at(-1)?.body.revision, "session-after-restart");
            assert.deepEqual(
                durableRequests,
                [],
                "private rendering, local expansion and guarded sends make no Durable API requests",
            );
            assert.equal(
                await value(page, `(await import('/store.js')).store.state.view.entries.size`),
                0,
                "private prompts never become Durable transcript entries",
            );
            await click(page, ".sidebar .private-import");
            await present(page, "#import-share-consent");
            assert.equal(
                requests.filter((item) => item.path === "/api/imports/active").length,
                0,
                "preview never publishes",
            );
            assert.equal(
                await value(
                    page,
                    `document.querySelector('.import-form button[type=submit]').disabled`,
                ),
                true,
            );
            assert.match(
                await value<string>(page, `document.querySelector('.import-form').textContent`),
                /other signed-in app users[\s\S]*archive stays owner-only/,
            );
            await shot(page, "shared-consent");
            await click(page, "#import-share-consent");
            await page.evaluate(`document.querySelector('.import-form').requestSubmit()`);
            await until(
                () => value(page, `location.pathname === '/s/${durableId}'`),
                "shared import route",
            );
            assert.equal(
                requests.find((item) => item.path === "/api/imports/active")?.body.visibility,
                "shared",
            );

            // A recovered shared intent must stay truthful in the normal Import picker too.
            await until(
                () => value(page, `!document.querySelector('.sheet-host')`),
                "previous sheet finished closing",
            );
            await page.evaluate(`(await import('/store.js')).openSheet({ type: 'import' })`);
            await present(page, ".import-session button");
            await click(page, ".import-session button");
            await present(page, "#import-share-consent");
            assert.equal(
                await value(
                    page,
                    `document.querySelector('.import-form').textContent.includes('This conversation stays owner-only')`,
                ),
                false,
            );
            assert.equal(
                await value(
                    page,
                    `document.querySelector('.import-form button[type=submit]').disabled`,
                ),
                true,
            );
            assert.equal(
                requests.filter(
                    (item) => item.path === "/api/imports/active" && item.method === "POST",
                ).length,
                1,
                "recovered preview also never publishes",
            );
            await click(page, "#import-share-consent");
            await until(
                () =>
                    value(
                        page,
                        `!document.querySelector('.import-form button[type=submit]').disabled`,
                    ),
                "recovered shared consent",
            );
            await page.evaluate(`document.querySelector('.import-form').requestSubmit()`);
            await until(
                () => value(page, `(await import('/store.js')).store.state.sheet === null`),
                "recovered shared move",
            );
            assert.equal(
                requests
                    .filter((item) => item.path === "/api/imports/active" && item.method === "POST")
                    .at(-1)?.body.visibility,
                "shared",
            );

            // A delayed old-pane snapshot must not appear after switching to a shell pane.
            detailDelay = 750;
            await page.evaluate(
                `(await import('/store.js')).navigate(null, { privateId: ${JSON.stringify(paneId)} })`,
            );
            await until(
                () => (inFlight.get(`/api/private/${encodeURIComponent(paneId)}`) ?? 0) > 0,
                "delayed request",
            );
            await page.evaluate(
                `(await import('/store.js')).navigate(null, { privateId: ${JSON.stringify(shellId)} })`,
            );
            await until(
                () => value(page, `document.body.textContent.includes('SHELL_ONLY_OUTPUT')`),
                "shell fallback",
            );
            assert.equal(
                await value(page, `document.body.textContent.includes('PRIVATE_SAVED_MESSAGE')`),
                false,
            );
            assert.equal(await value(page, `!!document.querySelector('#private-prompt')`), false);
            detailDelay = 0;
            detailStatus = 503;
            await until(
                () =>
                    value(
                        page,
                        `document.body.textContent.includes('Snapshot unavailable fixture')`,
                    ),
                "unavailable pane",
            );
            assert.equal(
                await value(page, `document.body.textContent.includes('SHELL_ONLY_OUTPUT')`),
                false,
                "failed snapshot clears old private output",
            );
            detailStatus = 200;
            await until(
                () => value(page, `document.body.textContent.includes('SHELL_ONLY_OUTPUT')`),
                "recovered snapshot",
            );

            await page.evaluate(
                `Object.defineProperty(document, 'visibilityState', { configurable: true, value: 'hidden' }); document.dispatchEvent(new Event('visibilitychange'));`,
            );
            const hiddenCount = requests.length;

            await new Promise((resolve) => setTimeout(resolve, 4400));
            assert.equal(requests.length, hiddenCount, "polling pauses while hidden");
            await page.evaluate(
                `Object.defineProperty(document, 'visibilityState', { configurable: true, value: 'visible' }); document.dispatchEvent(new Event('visibilitychange'));`,
            );
            await until(() => requests.length > hiddenCount, "poll resumes");
            await page.evaluate(
                `Object.defineProperty(navigator, 'onLine', { configurable: true, value: false }); window.dispatchEvent(new Event('offline'));`,
            );
            const offlineCount = requests.length;

            await new Promise((resolve) => setTimeout(resolve, 4400));
            assert.equal(requests.length, offlineCount, "polling pauses offline");
            await page.evaluate(
                `Object.defineProperty(navigator, 'onLine', { configurable: true, value: true }); window.dispatchEvent(new Event('online'));`,
            );
            await page.evaluate(
                `const { store } = await import('/store.js'); store.set({ me: { ...store.state.me, role: 'viewer' } });`,
            );
            await until(
                () => value(page, `!document.querySelector('.private-transcript')`),
                "role loss clears pane",
            );
            assert.equal(await value(page, `!!document.querySelector('.private-tabs')`), false);
            assert.equal(
                await value(page, `document.body.textContent.includes('SHELL_ONLY_OUTPUT')`),
                false,
            );
            const lostCount = requests.length;

            await new Promise((resolve) => setTimeout(resolve, 2300));
            assert.equal(requests.length, lostCount, "no private requests after role loss");
            detailStatus = 401;
            await page.evaluate(
                `const { store, api } = await import('/store.js'); store.set({ me: (await api('me')).user });`,
            );
            await until(
                () => value(page, `(await import('/store.js')).store.state.me === null`),
                "private auth failure signs out and clears data",
            );
            assert.equal(
                await value(page, `!!document.querySelector('.private-transcript')`),
                false,
            );
            assert.equal(
                overlap,
                false,
                `no overlapping snapshot requests: ${overlaps.join(", ")}`,
            );
            assert.deepEqual(
                page
                    .logs()
                    .filter(
                        (entry) =>
                            entry.level === "error" &&
                            !(
                                entry.source?.startsWith(`${base}/api/private/`) &&
                                /status of (401|409|503)/.test(entry.text)
                            ),
                    ),
                [],
                "no browser errors beyond deliberate Private API failures",
            );
        } finally {
            await browsers.closeAll({ final: true });
            server.closeAllConnections();
            await new Promise<void>((resolve) => server.close(() => resolve()));
            await app.close();
        }
    },
);
