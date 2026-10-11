// Whole owner browser -> private HTTP -> synthetic Herdr -> shared Durable import, without real process control.
import { cleanUp, context, openApp, owner, root, scriptedModel, until, work } from "./helpers.ts";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createServer } from "node:http";
import { join } from "node:path";
import { after, test } from "node:test";
import type { ConversationId } from "@earendil-works/pi-durable";
import { Browsers } from "../src/server/browser.ts";
import { findBrowser } from "../src/server/browser/discovery.ts";
import type { BrowserPage } from "../src/server/browser/page.ts";
import { VIEWPORTS } from "../src/server/browser/viewport.ts";
import { createHandler } from "../src/server/http.ts";
import { fakeHerdr } from "./active-import-fixture.ts";
import { importFixture } from "./import-fixtures.ts";

after(cleanUp);
const chromium = findBrowser();
const value = async <T>(page: BrowserPage, expression: string): Promise<T> =>
    JSON.parse(await page.evaluate(`return JSON.stringify(${expression})`)) as T;

test(
    "real Private UI reads/prompts the bridge then explicitly publishes one shared import with a private archive",
    { skip: chromium === undefined ? "no Chromium" : false, timeout: 60_000 },
    async () => {
        const source = importFixture(work);
        const model = scriptedModel();
        const app = await openApp(model);
        const guest = app.config.addUser("Collaborator", "guest");
        const { local, state, shell } = fakeHerdr(app, source.path);
        const original = local.request;
        const prompts: unknown[] = [];

        state.omitArgv = true;

        local.request = async <T>(socket: string, method: string, params = {}): Promise<T> => {
            if (method === "session.snapshot") {
                const result = await original<{
                    snapshot: {
                        workspaces: Record<string, unknown>[];
                        panes: Record<string, unknown>[];
                    };
                }>(socket, method, params);

                return {
                    snapshot: {
                        ...result.snapshot,
                        workspaces: result.snapshot.workspaces.map((workspace) => ({
                            ...workspace,
                            active_tab_id: "tab",
                        })),
                        tabs: [
                            {
                                tab_id: "tab",
                                workspace_id: "workspace",
                                label: "Main",
                                active_pane_id: "pane",
                            },
                        ],
                        panes: result.snapshot.panes.map((pane) => ({ ...pane, tab_id: "tab" })),
                    },
                } as T;
            }

            if (method === "pane.read") {
                return { read: { pane_id: "pane", text: "LIVE_NATIVE_PI" } } as T;
            }

            if (method === "agent.prompt") {
                assert.deepEqual(Object.keys(params).sort(), ["target", "text"]);
                assert.equal((params as { target: string }).target, "pane");
                prompts.push(params);

                return { type: "agent_prompted", agent: { pane_id: "pane", agent: "pi" } } as T;
            }

            return original(socket, method, params);
        };

        const server = createServer(
            createHandler({ app, listen: { host: "127.0.0.1", port: 0 }, restart: () => {} }),
        );
        const browsers = new Browsers({
            dataDir: join(root, "private-integration-browser"),
            load: async () => undefined,
            save: () => {},
        });

        await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
        const base = `http://127.0.0.1:${(server.address() as { port: number }).port}`;

        try {
            const page = await browsers.open(1);

            await page.setViewport(VIEWPORTS.mobile);
            await page.navigate(`${base}/login?token=${encodeURIComponent(app.config.ownerToken)}`);
            await until(
                () => value(page, `!!document.querySelector('.private-tabs')`),
                "sidebar tabs",
            );
            await page.evaluate(
                `[...document.querySelectorAll('.private-tabs button')].find(button => button.textContent.trim() === 'Herdr' && button.getClientRects().length).click()`,
            );
            await until(
                () => value(page, `!!document.querySelector('.private-pane-row')`),
                "native private tree",
            );
            assert.deepEqual(
                await value(
                    page,
                    `await (async () => { const {api}=await import('/store.js'); const tree=await api('private'); const workspace=tree.instances[0].workspaces[0]; const tab=workspace.tabs[0]; const pane=tab.panes[0]; return [workspace.nativeId,tab.nativeId,pane.nativeId,workspace.id !== workspace.nativeId,tab.id !== tab.nativeId,pane.id !== pane.nativeId]; })()`,
                ),
                ["workspace", "tab", "pane", true, true, true],
                "real PrivateSessions tree preserves native navigation IDs separately from opaque HTTP IDs",
            );
            await page.evaluate(
                `[...document.querySelectorAll('.private-pane-row')].find(button => button.getClientRects().length).click()`,
            );
            await until(
                () => value(page, `document.body.textContent.includes('LIVE_NATIVE_PI')`),
                "real terminal read",
            );
            assert.equal(app.sessions().length, 0);
            assert.deepEqual(state.signals, []);
            const route = await value<string>(page, "location.pathname");

            await page.navigate(base + route);
            await until(
                () => value(page, `!!document.querySelector('#private-prompt')`),
                "private deep link",
            );
            await page.evaluate(
                `const field = document.querySelector('#private-prompt'); field.value = 'Hello through the bridge'; field.dispatchEvent(new Event('input', {bubbles:true}));`,
            );
            await until(
                () =>
                    value(
                        page,
                        `!document.querySelector('.private-composer button[type=submit]').disabled`,
                    ),
                "ready prompt",
            );
            await page.evaluate(`document.querySelector('.private-composer').requestSubmit()`);
            await until(() => prompts.length === 1, "one Herdr agent prompt");
            await page.evaluate(`(await import('/store.js')).store.set({drawer:true})`);
            await until(
                () =>
                    value(
                        page,
                        `document.querySelector('.drawer .private-import')?.disabled === false`,
                    ),
                "ready sidebar import preview",
            );
            await page.evaluate(`document.querySelector('.drawer .private-import').click()`);
            await until(
                () => value(page, `!!document.querySelector('#import-share-consent')`),
                "explicit sharing consent",
            );
            assert.deepEqual(state.signals, [], "preview never stops Pi");
            assert.equal(app.sessions(guest.user).length, 0, "preview never publishes");
            await page.evaluate(
                `const model = document.querySelector('#import-model'); model.value='faux/faux-vision'; model.dispatchEvent(new Event('change',{bubbles:true})); document.querySelector('#import-share-consent').click();`,
            );
            await until(
                () =>
                    value(
                        page,
                        `!document.querySelector('.import-form button[type=submit]').disabled`,
                    ),
                "ready shared import",
            );
            await page.evaluate(`document.querySelector('.import-form').requestSubmit()`);
            await until(
                () =>
                    value(
                        page,
                        `location.pathname.startsWith('/s/') && document.body.textContent.includes('Ready to continue')`,
                    ),
                "Durable conversation opened",
            );
            const session = app.sessions(guest.user)[0]!;

            assert.ok(session);
            assert.equal(app.canSee(guest.user, session.id as ConversationId), true);
            assert.equal(app.sessions().length, 1);
            assert.equal(state.signals.length, 1);
            assert.deepEqual(state.table, [shell]);
            assert.equal(model.state.callCount, 0);
            assert.equal((await app.harness.inspect(context)).tasks.length, 0);
            assert.equal(
                await app.imports.archive(owner(app), session.id as ConversationId),
                source.archive,
            );
            assert.equal(readFileSync(source.path, "utf8"), source.archive);
            assert.equal(
                (
                    await fetch(`${base}/api/imports/${session.id}/archive`, {
                        headers: { authorization: `Bearer ${guest.token}` },
                    })
                ).status,
                403,
            );
            assert.deepEqual(
                page.logs().filter((entry) => entry.level === "error"),
                [],
            );
        } finally {
            await browsers.closeAll({ final: true });
            server.closeAllConnections();
            await new Promise<void>((resolve) => server.close(() => resolve()));
            await app.close();
        }
    },
);
