// Real Preact, Sheet, sheet registry/trail, store, history and app keyboard handlers in Chromium.
// Regression: an unregistered agent panel lets its dismissal arm Stop or coexist with a native sheet.
// Unrelated panels/composer are inert fixtures; HTTP/model execution and hardware are not under test.
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { build } from "esbuild";
import { Chromium } from "../src/server/browser/cdp.ts";
import { findBrowser } from "../src/server/browser/discovery.ts";

const root = fileURLToPath(new URL("..", import.meta.url));
const web = join(root, "web");
const executable = findBrowser();
const inert = (names: string) =>
    names
        .split(" ")
        .map((name) => `export const ${name}=()=>null;`)
        .join("\n");
const fixtures: Record<string, string> = {
    "browser-panel.js": inert("BrowserPanel BrowserButton"),
    "browser.js": inert("browserAvailable setBrowserOpen toggleBrowser"),
    "chat.js": inert("PeoplePanel PeopleButton ChatSheet jumpToEntry"),
    "composer.js": inert("Composer openingByAlt"),
    "files-panel.js": inert("FilesPanel FilesButton filesAvailable setFilesOpen toggleFiles"),
    "extension-ui.js": inert(
        "ExtensionPage ExtensionSessionControls ExtensionSheet onExtensionsGone",
    ),
    "home.js": inert("Splash"),
    "launcher.js": inert("Launcher"),
    "notify.js": inert("registerWorker updateBadge"),
    "peeks.js": `export const PEEK_WIDE={matches:false}; ${inert("PeekHost PeekStrip peekTiles peeksWanted togglePeeks PeeksButton")}`,
    "pip.js": inert("closePip openPip PipHost pipAvailable togglePip"),
    "sessions.js": `${inert("Drawer Rail ResizeHandle SessionList")} export const toSessions=()=>{};`,
    "private.js": inert("PrivatePane"),
    "rich.js": "",
    "share.js": inert("takeShare ShareSheet"),
    "signin.js": inert("SignIn"),
    "subagents-board.js": inert("SubagentsBoard"),
    "terminal-renderer-assets.js": inert("startTerminalRendererPrefetch"),
    "voice.js": inert("toggleDictation"),
    "transcript.js": inert("Transcript"),
    "agent-draft-pane.js": inert("AgentDraftPane"),
    "avatar.js": inert("folderColor"),
    "diff.js": "export const useChanges=()=>({changes:null});",
    "subagents.js": inert("openSubagents"),
    "thread-type.js": inert("ThreadTypeTag"),
    "workspace-location.js": inert("conversationLocation"),
    "named-agents.js": `import {openSheet,store} from './store.js';
        export const namedAgentsAvailable=()=>store.state.me?.role==='owner';
        export const openAgentSettings=(id,agentId,section)=>openSheet({type:'named-agent',id,agentId,section});
        ${inert("AgentModelPicker NamedAgentSheet")}`,
    "sheets/branch.js": inert("BranchPicker branchAvailable headLabel"),
    "sheets/file.js": inert("FileSheet"),
    "sheets/gallery.js": inert(
        "galleryAvailable GalleryEntrySheet GalleryShareSheet GallerySheet GallerySourceSheet GalleryUpdateSheet",
    ),
    "sheets/pi-sessions.js": inert("ImportSheet piSessionsAvailable"),
    "sheets/folder.js": inert("CwdSheet"),
    "sheets/memory.js": inert("MemorySheet"),
    "sheets/menu.js": inert("MenuSheet PlacesSheet"),
    "sheets/message.js": inert("MessageSheet"),
    "sheets/model.js": inert("ModelPicker"),
    "sheets/pip.js": inert("PipModelPicker"),
    "sheets/people.js": inert("InviteSheet"),
    "sheets/providers.js": inert("AuthDialog"),
    "sheets/running.js": inert("RunningSheet"),
    "sheets/hooks.js": inert("HooksSheet"),
    "sheets/schedules.js": inert("SchedulesSheet"),
    "sheets/settings.js": inert("SettingsSheet"),
    "sheets/session.js": inert("NewSessionSheet SessionActions"),
    "sheets/project.js": inert("ProjectSheet"),
    "sheets/session-move.js": inert("SessionMoveSheet"),
    "sheets/sidebar-options.js": inert("SidebarOptions"),
    "sheets/shortcuts.js": inert("ShortcutsSheet"),
    "sheets/text.js": inert("TextSheet"),
    "sheets/viewers.js": inert("ArtifactsSheet ArtifactViewer ImageViewer"),
    "sheets/work-item-limits.js": inert("WorkItemLimitsSheet"),
    "sheets/worktree.js": inert("WorktreeSheet"),
    "trust.js": inert("TrustSheet"),
};

async function bundle() {
    const result = await build({
        stdin: {
            resolveDir: web,
            contents: `import {store} from './store.js';
                window.modalStore=store;
                store.set({me:{id:'modal-owner',role:'owner'},connection:'open',
                    server:{privateAgents:4,extensions:['pocket-memory']},
                    namedAgents:[{agentId:'modal-agent',name:'Reviewer',chatIds:[7,19],
                        chats:[{id:7,title:'Setup'},{id:19,title:'Busy review',busy:true}]}],
                    view:{...store.state.view,conversation:{id:19,pipAgentId:'modal-agent',title:'Busy review'},live:{busy:true}}});
                import('./app.js');`,
        },
        bundle: true,
        write: false,
        format: "esm",
        plugins: [
            {
                name: "unrelated-ui-boundaries",
                setup(builder) {
                    // Resolve installed browser dependencies through Node, like the app's import map.
                    builder.onResolve({ filter: /^[^./]/ }, (args) => ({
                        path: fileURLToPath(import.meta.resolve(args.path)),
                    }));
                    builder.onLoad({ filter: /\/web\/.*\.js$/ }, (args) => {
                        const replacement = fixtures[args.path.slice(web.length + 1)];

                        return replacement === undefined
                            ? undefined
                            : {
                                  contents: replacement,
                                  resolveDir: dirname(args.path),
                              };
                    });
                },
            },
        ],
    });

    return result.outputFiles[0].text;
}

test(
    "agent panels dismiss before Stop and share native sheet focus, shortcuts and Back",
    {
        skip: executable === undefined ? "no Chromium installed" : false,
        timeout: 45_000,
    },
    async (t) => {
        const script = await bundle();
        const posts: string[] = [];
        const server = createServer((req, res) => {
            const path = new URL(req.url!, "http://localhost").pathname;

            if (path === "/api/me" || path === "/api/events") {
                // No transport lifecycle is being tested; keep the seeded busy Chat unchanged.
                return;
            }

            if (path.startsWith("/api/")) {
                if (req.method === "POST") {
                    posts.push(path);
                }

                const data =
                    path === "/api/c/19/private-agent"
                        ? { id: 19, agentId: "modal-agent", controllers: [] }
                        : path === "/api/pip/agents/modal-agent"
                          ? {
                                agentId: "modal-agent",
                                chats: [
                                    { id: 7, title: "Setup" },
                                    { id: 19, title: "Busy review", busy: true },
                                ],
                            }
                          : {};

                res.writeHead(200, { "Content-Type": "application/json" }).end(
                    JSON.stringify(data),
                );
            } else if (path === "/fixture.js") {
                res.writeHead(200, { "Content-Type": "text/javascript" }).end(script);
            } else if (path.endsWith(".css")) {
                res.writeHead(200, { "Content-Type": "text/css" }).end(
                    readFileSync(resolve(web, `.${path}`)),
                );
            } else {
                res.writeHead(200, { "Content-Type": "text/html" }).end(`<!doctype html>
                <meta name="viewport" content="width=device-width,initial-scale=1">
                <link rel="stylesheet" href="/style.css">
                <div id="app"></div><script type="module" src="/fixture.js"></script>`);
            }
        });

        await new Promise<void>((done, reject) => {
            server.once("error", reject);
            server.listen(0, "127.0.0.1", done);
        });
        const profile = mkdtempSync(join(tmpdir(), "agent-modal-"));
        let launched: Chromium | undefined;

        t.after(async () => {
            await launched?.stop();
            server.closeAllConnections();
            await new Promise<void>((done) => server.close(() => done()));
            rmSync(profile, { recursive: true, force: true });
        });

        const address = server.address();

        assert.ok(address && typeof address !== "string");

        const browser = (launched = await Chromium.launch(executable!, profile, []));

        const { targetId } = await browser.connection.send("Target.createTarget", {
            url: "about:blank",
        });
        const { sessionId } = await browser.connection.send("Target.attachToTarget", {
            targetId,
            flatten: true,
        });
        const send = (method: string, params = {}) =>
            browser.connection.send(method, params, sessionId);
        const evaluate = async <T>(expression: string): Promise<T> => {
            const result = await send("Runtime.evaluate", {
                expression,
                awaitPromise: true,
                returnByValue: true,
            });

            assert.equal(
                result.exceptionDetails,
                undefined,
                JSON.stringify(result.exceptionDetails),
            );

            return result.result.value;
        };
        const until = async (expression: string) => {
            for (let attempt = 0; attempt < 150; attempt++) {
                if (await evaluate<boolean>(expression)) {
                    return;
                }

                await new Promise((done) => setTimeout(done, 20));
            }

            assert.fail(`Timed out: ${expression}\n${await evaluate("document.body.innerText")}`);
        };
        const click = async (selector: string) => {
            await until(`document.querySelector(${JSON.stringify(selector)}) !== null`);
            await evaluate(
                `document.querySelector(${JSON.stringify(selector)}).focus(); document.querySelector(${JSON.stringify(selector)}).click()`,
            );
        };
        const key = async (key: string, code: string, modifiers = 0) => {
            await send("Input.dispatchKeyEvent", { type: "keyDown", key, code, modifiers });
            await send("Input.dispatchKeyEvent", { type: "keyUp", key, code, modifiers });
        };
        let loaded = 0;

        browser.connection.listen(sessionId, (method) => {
            if (method === "Page.loadEventFired") {
                loaded++;
            }
        });
        await send("Page.enable");

        const fresh = async () => {
            const before = loaded;

            await send("Page.navigate", { url: `http://127.0.0.1:${address.port}/s/19` });

            for (let attempt = 0; loaded === before && attempt < 150; attempt++) {
                await new Promise((done) => setTimeout(done, 20));
            }

            assert.ok(loaded > before, "the fresh fixture loaded");
            await until(`document.querySelector('.agent-header-history') !== null`);
        };

        await send("Emulation.setDeviceMetricsOverride", {
            width: 390,
            height: 844,
            deviceScaleFactor: 1,
            mobile: false,
        });

        for (const selector of [
            ".agent-header-history",
            ".agent-chat-switch",
            ".agent-controller-summary",
            ".topbar-menu",
        ]) {
            await fresh();
            await click(selector);
            await until(
                `document.querySelector('[aria-modal="true"]')?.contains(document.activeElement)`,
            );
            await key("Escape", "Escape");
            await until(
                `document.querySelector('[aria-modal="true"]:not([data-state="closing"])') === null`,
            );
            assert.equal(
                await evaluate(
                    `window.modalStore.state.notices.some(n=>n.message.includes('Press Esc again'))`,
                ),
                false,
                `${selector}: dismissal must not arm Stop`,
            );
            assert.deepEqual(posts, [], `${selector}: dismissal never stops busy work`);
            assert.equal(
                await evaluate(`document.activeElement.matches(${JSON.stringify(selector)})`),
                true,
                "focus returns to the header opener",
            );
            await key("Escape", "Escape");
            await until(
                `window.modalStore.state.notices.some(n=>n.message.includes('Press Esc again'))`,
            );
            assert.deepEqual(posts, [], "the first ordinary Esc after dismissal only arms Stop");
        }

        // Positive control: the real global keyboard handler and native abort transport are connected.
        await key("Escape", "Escape");
        await until(
            `window.modalStore.state.notices.every(n=>!n.message.includes('Press Esc again'))`,
        );
        for (let attempt = 0; posts.length === 0 && attempt < 100; attempt++) {
            await new Promise((done) => setTimeout(done, 10));
        }
        assert.deepEqual(posts, ["/api/c/19/abort"]);
        posts.length = 0;

        await fresh();
        await click(".topbar-menu");
        await click(".agent-menu-action"); // History from the agent menu.
        await until(
            `document.querySelector('[role="dialog"]')?.getAttribute('aria-label') === 'Reviewer · History'`,
        );
        const findModifier = (await evaluate<boolean>(
            `/Mac|iPhone|iPad|iPod/.test(navigator.platform)`,
        ))
            ? 4
            : 2;

        await key("f", "KeyF", findModifier);
        await until(`document.querySelector('[data-sheet="find"]') !== null`);
        await until(`history.state?.pocket?.layers === 3`);
        assert.equal(
            await evaluate(`document.querySelectorAll('[aria-modal="true"]').length`),
            1,
            "native Find replaces the agent panel instead of layering a second modal",
        );
        await key("Tab", "Tab");
        assert.equal(
            await evaluate(
                `document.querySelector('[data-sheet="find"]').contains(document.activeElement)`,
            ),
            true,
            "Tab remains in the topmost native sheet",
        );
        await click(".sheet-back");
        await until(
            `document.querySelector('[role="dialog"]')?.getAttribute('aria-label') === 'Reviewer · History'`,
        );
        await click(".sheet-back");
        await until(`document.querySelector('.agent-header-menu') !== null`);
        await key("Escape", "Escape");
        assert.deepEqual(
            posts,
            [],
            "Back and nested dismissal do not stop the busy originating Chat",
        );
    },
);
