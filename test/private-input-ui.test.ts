// Real Chromium -> authenticated HTTP -> PrivateSessions -> synthetic Herdr. No live Herdr or Pi.
import { cleanUp, context, openApp, owner, root, scriptedModel, until, work } from "./helpers.ts";
import assert from "node:assert/strict";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import { join } from "node:path";
import { after, test } from "node:test";
import { Browsers } from "../src/server/browser.ts";
import { findBrowser } from "../src/server/browser/discovery.ts";
import type { BrowserPage } from "../src/server/browser/page.ts";
import { VIEWPORTS } from "../src/server/browser/viewport.ts";
import { createHandler } from "../src/server/http.ts";
import { fakeHerdr } from "./active-import-fixture.ts";
import { importFixture } from "./import-fixtures.ts";

const chromium = findBrowser();
const field = "#private-prompt";
const send = ".private-composer button[type=submit]";
const chip = ".private-composer .model-chip[aria-label='Change private Pi model']";
const picker = "[role=dialog][aria-label=Model]";

after(cleanUp);

async function value<T>(page: BrowserPage, expression: string): Promise<T> {
    return JSON.parse(await page.evaluate(`return JSON.stringify(${expression})`)) as T;
}

async function present(page: BrowserPage, selector: string, expected = true) {
    await until(
        () => value(page, `!!document.querySelector(${JSON.stringify(selector)}) === ${expected}`),
        `${expected ? "show" : "hide"} ${selector}`,
    );
}

async function click(page: BrowserPage, selector: string) {
    await page.evaluate(`document.querySelector(${JSON.stringify(selector)}).click()`);
}

async function fill(page: BrowserPage, text: string) {
    await page.evaluate(`
        (() => {
            const input = document.querySelector('#private-prompt');
            input.value = ${JSON.stringify(text)};
            input.dispatchEvent(new InputEvent('input', { bubbles: true }));
            input.focus();
        })();
    `);
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

/** Chromium supplies actual File objects and bytes to the production paste/drop/change handlers. */
async function attach(
    page: BrowserPage,
    kind: "paste" | "drop" | "change",
    name: string,
    bytes: Buffer,
    type = "application/octet-stream",
) {
    await page.evaluate(`
        const transfer = new DataTransfer();
        transfer.items.add(new File([new Uint8Array(${JSON.stringify([...bytes])})],
            ${JSON.stringify(name)}, { type: ${JSON.stringify(type)} }));
        if (${JSON.stringify(kind)} === 'change') {
            const input = document.querySelector('.private-composer input[type=file]');
            input.files = transfer.files;
            input.dispatchEvent(new Event('change', { bubbles: true }));
        } else if (${JSON.stringify(kind)} === 'paste') {
            document.querySelector('#private-prompt').dispatchEvent(new ClipboardEvent('paste', {
                clipboardData: transfer, bubbles: true, cancelable: true,
            }));
        } else {
            document.querySelector('.private-composer .composer').dispatchEvent(new DragEvent('drop', {
                dataTransfer: transfer, bubbles: true, cancelable: true,
            }));
        }
    `);
    await present(page, `.private-attachments [aria-label=${JSON.stringify(`Remove ${name}`)}]`);
}

type Request = { path: string; method: string; name: string | null; body: string; status?: number };

/** The native prompt exposes saved paths, not browser upload tokens. Read those files independently. */
function dispatchedFiles(text: string, draft: string, expected: Buffer[]): string[] {
    const heading = "Attached files (use read on these paths, including images): ";
    const prefix = `${draft ? `${draft} ` : ""}${heading}`;

    assert.ok(text.startsWith(prefix), "native Pi receives the draft and private read paths");
    const paths: string[] = JSON.parse(text.slice(prefix.length));

    assert.equal(paths.length, expected.length);

    for (const [index, path] of paths.entries()) {
        assert.deepEqual(readFileSync(path), expected[index], "native attachment bytes are intact");
    }

    return paths;
}

test(
    "Private composer: native commands/model, byte-exact files, acknowledged clearing and revision-safe drafts",
    { skip: chromium === undefined ? "no Chromium installed" : false, timeout: 90_000 },
    async (t) => {
        const source = importFixture(work);
        const model = scriptedModel();
        const app = await openApp(model);
        const fake = fakeHerdr(app, source.path);
        const original = fake.local.request;
        const native: { target: string; text: string }[] = [];
        const methods: string[] = [];
        let acknowledgement: Promise<void> | undefined;
        let failPrompt = false;
        let saveModelChange = false;

        fake.state.omitArgv = true;

        fake.local.request = async <T>(socket: string, method: string, params = {}): Promise<T> => {
            methods.push(method);

            if (method === "pane.read") {
                return { read: { pane_id: "pane", text: "PRIVATE_INPUT_NATIVE_PI" } } as T;
            }

            if (method === "agent.prompt") {
                const prompt = params as { target: string; text: string };

                native.push(prompt);
                await acknowledgement;

                if (failPrompt) {
                    throw new Error("Synthetic native acknowledgement lost after input");
                }

                if (saveModelChange && prompt.text === "/model faux/faux-2") {
                    source.source.appendModelChange("faux", "faux-2");
                }

                return { type: "agent_prompted", agent: { pane_id: "pane", agent: "pi" } } as T;
            }

            return original(socket, method, params);
        };

        const list = await app.privateSessions.list(owner(app));
        const paneId = list.instances[0]!.workspaces[0]!.tabs[0]!.panes[0]!.id;
        const promptPath = `/api/private/${paneId}/prompt`;
        const requests: Request[] = [];
        const handler = createHandler({
            app,
            listen: { host: "127.0.0.1", port: 0 },
            restart: () => {},
        });
        let uploadGate: Promise<void> | undefined;
        const server = createServer(async (request, response) => {
            const url = new URL(request.url!, "http://fixture");
            const record: Request = {
                path: url.pathname,
                method: request.method!,
                name: url.searchParams.get("name"),
                body: "",
            };

            requests.push(record);
            response.on("finish", () => {
                record.status = response.statusCode;
            });

            // Delay the transport, not the upload implementation or its receipt. The real handler
            // still authenticates, streams bytes, checks revisions and creates the opaque token.
            if (record.path.endsWith("/upload") && record.method === "POST") {
                await uploadGate;
            }

            if (record.path === promptPath) {
                request.on("data", (chunk) => {
                    record.body += chunk;
                });
            }

            await handler(request, response);
        });
        const browsers = new Browsers({
            dataDir: join(root, "private-input-browser"),
            load: async () => undefined,
            save: () => {},
        });
        const release = new Set<() => void>();

        const hold = () => {
            const gate = Promise.withResolvers<void>();

            release.add(gate.resolve);

            return gate;
        };

        await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
        const base = `http://127.0.0.1:${(server.address() as { port: number }).port}`;

        try {
            const page = await browsers.open(1);
            const draft = () => value<string>(page, `document.querySelector('${field}').value`);
            const ready = () =>
                until(
                    () => value(page, `document.querySelector('${send}')?.disabled === false`),
                    "uploads complete and composer ready",
                );

            const cleared = async () => {
                await until(
                    () => value(page, `document.querySelector('${field}').value === ''`),
                    "acknowledged draft clear",
                );
                await present(page, ".private-attachments", false);
            };

            const submit = () =>
                page.evaluate(`document.querySelector('.private-composer').requestSubmit()`);
            const prompts = () => requests.filter((request) => request.path === promptPath);
            const uploads = () =>
                requests.filter(
                    (request) => request.path.endsWith("/upload") && request.method === "POST",
                );
            const activeCommand = () =>
                value<string>(
                    page,
                    `document.querySelector('#private-commands [aria-selected=true] .command-name').textContent`,
                );

            await page.setViewport(VIEWPORTS.mobile);
            await page.navigate(`${base}/login?token=${encodeURIComponent(app.config.ownerToken)}`);
            await present(page, ".private-tabs");
            await page.navigate(`${base}/private/${paneId}`);
            await present(page, field);
            await present(page, ".private-composer [aria-label='Attach files']");
            await present(page, ".private-composer input[type=file]");
            // Keep Chat explicitly selected when resizing; never launch a native terminal helper.
            await click(page, ".private-view-switch button:last-child");

            await fill(page, "/");
            await present(page, "#private-commands[role=listbox][aria-label='Pi commands']");
            assert.equal(await activeCommand(), "/model");
            await shot(page, "private-input-mobile-commands");
            await page.press("ArrowDown");
            assert.equal(await activeCommand(), "/thinking");
            await page.press("ArrowUp");
            assert.equal(await activeCommand(), "/model");
            await page.press("ArrowDown");
            await page.press("Tab");
            assert.equal(await draft(), "/thinking ");
            await present(page, "#private-commands", false);
            assert.equal(native.length, 0, "Tab completes, without dispatching");

            await page.setViewport(VIEWPORTS.desktop);
            await fill(page, "/");
            await present(page, "#private-commands");
            await shot(page, "private-input-desktop-commands");
            await page.press("ArrowDown");
            await page.press("ArrowDown");
            await page.press("Enter");
            assert.equal(await draft(), "/compact ");
            assert.equal(native.length, 0, "Enter completes, rather than sending a command");
            await fill(page, "/");
            await page.press("Escape");
            await present(page, "#private-commands", false);
            assert.equal(
                await draft(),
                "/",
                "Escape dismisses suggestions without changing the draft",
            );

            await page.setViewport(VIEWPORTS.mobile);
            await fill(page, "/model");
            await page.press("Enter");
            await present(page, picker);
            await present(page, `${picker} .pop-menu-list[role=listbox]`);
            await until(
                () => value(page, "history.state?.pocket?.layers === 1"),
                "mobile picker history layer",
            );
            await shot(page, "private-input-mobile-picker");
            await click(page, ".pop-overlay");
            await present(page, picker, false);
            await until(
                () => value(page, "history.state?.pocket?.layers === 0"),
                "mobile picker history closed",
            );
            await page.setViewport(VIEWPORTS.desktop);
            await fill(page, "/model faux-2");
            await page.press("Enter");
            await present(page, `${picker} input[placeholder='Search models']`);
            assert.equal(
                await value(page, `document.querySelector('${picker} input').value`),
                "faux-2",
            );
            assert.equal(
                await value(
                    page,
                    `document.querySelectorAll('${picker} .pop-menu-list [role=option]').length`,
                ),
                1,
            );
            await until(
                () => value(page, "history.state?.pocket?.layers === 1"),
                "desktop picker history layer",
            );
            await shot(page, "private-input-desktop-picker");
            await click(page, ".pop-overlay");
            await present(page, picker, false);
            await until(
                () => value(page, "history.state?.pocket?.layers === 0"),
                "desktop picker history closed",
            );
            assert.equal(prompts().length, 0, "opening either /model picker never sends input");

            await fill(page, "/compact Keep current names exactly");
            await ready();
            await submit();
            await until(() => native.length === 1, "ordinary slash command reaches native Pi");
            await cleared();
            assert.deepEqual(native[0], {
                target: "pane",
                text: "/compact Keep current names exactly",
            });

            const ordinary = "Keep the ordinary draft";
            const removedBytes = Buffer.from([0, 255, 10, 23]);
            const notes = Buffer.from("Private notes \u0000 with UTF-8: café\n");
            const image = Buffer.from(
                "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aG0sAAAAASUVORK5CYII=",
                "base64",
            );

            await fill(page, ordinary);
            await attach(page, "drop", "remove.bin", removedBytes);
            await ready();
            await click(page, ".private-attachments [aria-label='Remove remove.bin']");
            await present(page, ".private-attachments", false);
            await until(
                () =>
                    requests.some(
                        (request) => request.method === "DELETE" && request.status === 200,
                    ),
                "Remove discards the actual staged upload",
            );
            assert.equal(await draft(), ordinary);

            const uploading = hold();

            uploadGate = uploading.promise;
            await attach(page, "paste", "private notes.txt", notes, "text/plain");
            await until(() => uploads().length === 2, "pasted file starts a private upload");
            assert.equal(await value(page, `document.querySelector('${send}').disabled`), true);
            await submit();
            assert.equal(native.length, 1, "an unfinished upload cannot dispatch the draft");
            uploading.resolve();
            uploadGate = undefined;
            await ready();
            await attach(page, "change", "private-image.png", image, "image/png");
            await ready();
            assert.equal(
                await value(
                    page,
                    `document.querySelector('.private-composer input[type=file]').value`,
                ),
                "",
                "the chooser can select a file again",
            );

            await until(
                () =>
                    value(
                        page,
                        `document.querySelector(${JSON.stringify(chip)}).title === 'faux/faux-1'`,
                    ),
                "model chip reflects the real saved journal",
            );
            await click(page, chip);
            await present(page, picker);
            await click(page, `${picker} .pop-menu-list [title^='faux/faux-1 ']`);
            await present(page, picker, false);
            assert.equal(
                native.length,
                1,
                "picking the saved model must not send a command that could open a scoped-model selector",
            );
            assert.equal(prompts().length, 1);
            assert.equal(await draft(), ordinary);
            await ready();

            await click(page, chip);
            await present(page, picker);
            await click(page, `${picker} .pop-menu-list [title^='faux/faux-2 ']`);
            await until(
                () => native.length === 2 && prompts().at(-1)?.status === 200,
                "unobserved model command acknowledged",
            );
            await until(
                () =>
                    value(
                        page,
                        `document.body.textContent.includes('Waiting for the saved model to change')`,
                    ),
                "unobserved switch blocks follow-up input",
            );
            assert.deepEqual(native[1], { target: "pane", text: "/model faux/faux-2" });
            assert.equal(await draft(), ordinary);
            assert.equal(
                await value(page, "document.querySelectorAll('.private-attachment-name').length"),
                2,
            );
            assert.equal(
                await value(page, `document.querySelector(${JSON.stringify(chip)}).title`),
                "faux/faux-1",
            );
            assert.equal(await value(page, `document.querySelector('${send}').disabled`), true);
            await submit();
            assert.equal(
                native.length,
                2,
                "transport acknowledgement cannot admit a follow-up draft",
            );
            await page.evaluate(
                `[...document.querySelectorAll('.private-composer button')].find(button => button.textContent === "I checked Pi's editor").click()`,
            );
            await ready();
            assert.equal(
                await draft(),
                ordinary,
                "explicit editor check preserves draft and files",
            );
            assert.equal(
                await value(page, `document.querySelector(${JSON.stringify(chip)}).title`),
                "faux/faux-1",
                "explicit check does not invent saved model metadata",
            );

            saveModelChange = true;
            const modelAck = hold();

            acknowledgement = modelAck.promise;
            await click(page, chip);
            await present(page, picker);
            await click(page, `${picker} .pop-menu-list [title^='faux/faux-2 ']`);
            await until(() => native.length === 3, "selected model reaches native Pi");
            assert.deepEqual(native[2], { target: "pane", text: "/model faux/faux-2" });
            assert.equal(await draft(), ordinary);
            assert.equal(
                await value(page, "document.querySelectorAll('.private-attachment-name').length"),
                2,
            );
            assert.equal(
                await value(page, `document.querySelector(${JSON.stringify(chip)}).title`),
                "faux/faux-1",
                "dispatch does not optimistically invent a saved model",
            );
            modelAck.resolve();
            acknowledgement = undefined;
            await ready();
            await until(
                () =>
                    value(
                        page,
                        `document.querySelector(${JSON.stringify(chip)}).title === 'faux/faux-2'`,
                    ),
                "native model_change becomes the latest saved model chip",
            );
            assert.equal(await draft(), ordinary, "model acknowledgement preserves ordinary text");
            assert.equal(
                await value(page, "document.querySelectorAll('.private-attachment-name').length"),
                2,
                "model acknowledgement preserves files",
            );
            assert.equal(
                JSON.parse(prompts()[2]!.body).attachments,
                undefined,
                "/model never consumes the pending files",
            );
            await shot(page, "private-input-desktop-attached");
            await page.setViewport(VIEWPORTS.mobile);
            await shot(page, "private-input-mobile-attached");
            assert.equal(
                await value(page, "document.documentElement.scrollWidth <= innerWidth"),
                true,
            );

            const messageAck = hold();

            acknowledgement = messageAck.promise;
            await click(page, send);
            await until(
                () => native.length === 4,
                "text and files reach the native dispatch boundary",
            );
            const paths = dispatchedFiles(native[3]!.text, ordinary, [notes, image]);
            const sentBody = JSON.parse(prompts()[3]!.body) as {
                text: string;
                attachments: unknown[];
            };

            assert.equal(sentBody.text, ordinary);
            assert.equal(sentBody.attachments.length, 2);
            assert.ok(
                sentBody.attachments.every(
                    (token) => typeof token === "string" && /^[a-f0-9-]{36}$/.test(token),
                ),
                "HTTP sends opaque tokens, not filenames or native paths",
            );
            assert.equal(await draft(), ordinary, "only an acknowledgement may clear the draft");
            assert.equal(
                await value(page, "document.querySelectorAll('.private-attachment-name').length"),
                2,
            );
            await submit();
            assert.equal(native.length, 4, "pending submission is not duplicated");
            messageAck.resolve();
            acknowledgement = undefined;
            await cleared();
            assert.deepEqual(
                paths.map((path) => readFileSync(path)),
                [notes, image],
                "acknowledged clearing does not delete files Pi reads",
            );

            const onlyFile = Buffer.from([0, 13, 10, 128, 255]);

            await attach(page, "drop", "only-file.bin", onlyFile);
            await ready();
            await click(page, send);
            await until(() => native.length === 5, "attachments-only prompt is accepted");
            dispatchedFiles(native[4]!.text, "", [onlyFile]);
            assert.equal(JSON.parse(prompts()[4]!.body).text, "");
            await cleared();

            // Move to another generated journal, leaving an old-revision token in the real registry.
            await fill(page, "Preserve the stale attachment draft");
            await attach(page, "paste", "stale.txt", notes, "text/plain");
            await ready();
            const replacementDirectory = join(work, "replacement");

            mkdirSync(replacementDirectory);
            fake.state.path = importFixture(replacementDirectory).path;
            await until(
                () =>
                    value(
                        page,
                        `document.body.textContent.includes('The Pi session in this pane changed')`,
                    ),
                "new session invalidates the staged attachment revision",
            );
            assert.equal(await value(page, `document.querySelector('${send}').disabled`), true);
            await submit();
            assert.equal(native.length, 5, "stale draft does not dispatch automatically");
            assert.equal(
                await value(
                    page,
                    `[...document.querySelectorAll('.private-composer button')].find(button => button.textContent.includes('Use draft')).disabled`,
                ),
                true,
                "draft review cannot make old-revision files eligible for a different Pi session",
            );
            assert.match(
                await value<string>(
                    page,
                    "document.querySelector('.private-composer').textContent",
                ),
                /Remove these attachments and attach them again/,
            );
            assert.equal(prompts().length, 5, "stale attachments are refused before HTTP dispatch");
            assert.equal(await draft(), "Preserve the stale attachment draft");
            await present(page, ".private-attachments [aria-label='Remove stale.txt']");
            await click(page, ".private-attachments [aria-label='Remove stale.txt']");
            await present(page, ".private-attachments", false);
            await page.evaluate(
                `[...document.querySelectorAll('.private-composer button')].find(button => button.textContent.includes('Use draft')).click()`,
            );
            await ready();

            // A known-unsent refusal must leave its upload removable, not consuming the pane's
            // staging quota until expiry. The native boundary must not see the invalid message.
            await fill(page, "Unsupported\nmultiline");
            await attach(page, "drop", "rejected.bin", onlyFile);
            await ready();
            await submit();
            await until(
                () => prompts().at(-1)?.status === 400,
                "invalid input rejected before native delivery",
            );
            assert.equal(native.length, 5);
            assert.equal(await draft(), "Unsupported\nmultiline");
            const deletesBeforeRefusal = requests.filter(
                (request) => request.method === "DELETE",
            ).length;

            await click(page, ".private-attachments [aria-label='Remove rejected.bin']");
            await present(page, ".private-attachments", false);
            await until(() => {
                const deletes = requests.filter((request) => request.method === "DELETE");

                return deletes.length > deletesBeforeRefusal && deletes.at(-1)?.status === 200;
            }, "rejected upload is deleted from the real staging registry");

            // Native input happened, but its acknowledgement was lost: keep both draft and files.
            await fill(page, "Preserve uncertain draft and bytes");
            await attach(page, "change", "uncertain.bin", onlyFile);
            await ready();
            failPrompt = true;
            await click(page, send);
            await until(
                () => native.length === 6 && prompts().at(-1)?.status === 503,
                "lost native acknowledgement reaches the real HTTP error boundary",
            );
            const uncertainPaths = dispatchedFiles(
                native[5]!.text,
                "Preserve uncertain draft and bytes",
                [onlyFile],
            );

            await until(
                () => value(page, `document.body.textContent.includes('Delivery is uncertain')`),
                "uncertain delivery is visible",
            );
            assert.equal(await draft(), "Preserve uncertain draft and bytes");
            await present(page, ".private-attachments [aria-label='Remove uncertain.bin']");
            assert.equal(await value(page, `document.querySelector('${send}').disabled`), true);
            await submit();
            assert.equal(
                native.length,
                6,
                "uncertain delivery cannot be retried by form submission",
            );
            assert.deepEqual(readFileSync(uncertainPaths[0]!), onlyFile);

            assert.deepEqual(
                requests.filter((request) => request.path.startsWith("/api/c/")),
                [],
                "private input never reaches Durable submit/configure/upload",
            );
            assert.equal(
                requests.some((request) => request.path.endsWith("/terminal")),
                false,
                "the mobile-first fixture never opens a native terminal",
            );
            assert.deepEqual(app.sessions(), []);
            assert.equal(model.state.callCount, 0);
            assert.equal((await app.harness.inspect(context)).tasks.length, 0);
            assert.deepEqual(fake.state.signals, []);
            assert.ok(
                methods.every((method) =>
                    ["session.snapshot", "pane.process_info", "pane.read", "agent.prompt"].includes(
                        method,
                    ),
                ),
                "commands and attachments never fall back to raw terminal input",
            );
            assert.deepEqual(
                page
                    .logs()
                    .filter(
                        (entry) =>
                            entry.level === "error" &&
                            !(
                                entry.source?.startsWith(`${base}${promptPath}`) &&
                                /status of (400|409|503)/.test(entry.text)
                            ),
                    ),
                [],
                "no browser errors except deliberate prompt refusals",
            );
        } catch (error) {
            t.diagnostic(
                JSON.stringify(
                    requests
                        .filter(({ path }) => path.startsWith("/api/private"))
                        .map(({ path, method, status }) => ({ path, method, status })),
                ),
            );
            t.diagnostic(JSON.stringify(browsers.page(1)?.logs()));

            throw error;
        } finally {
            for (const resolve of release) {
                resolve();
            }

            await browsers.closeAll({ final: true });
            server.closeAllConnections();
            await new Promise<void>((resolve) => server.close(() => resolve()));
            await app.close();
        }
    },
);
