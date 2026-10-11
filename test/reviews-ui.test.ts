// Real Changes UI, two isolated browser identities, and a generated repository. Backend tests own
// authorization and snapshot persistence; this test owns accessible actions, live rendering, and
// keeping the working diff separate from an approved saved diff. No production test hooks or mocks.
import {
    type App,
    cleanUp,
    newSession,
    openApp,
    owner,
    root,
    scriptedModel,
    until,
    work,
} from "./helpers.ts";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { createServer, type Server } from "node:http";
import { join } from "node:path";
import { after, before, test } from "node:test";
import type { ConversationId } from "@earendil-works/pi-durable";
import { Auth } from "../src/server/auth.ts";
import { Browsers } from "../src/server/browser.ts";
import { findBrowser } from "../src/server/browser/discovery.ts";
import type { BrowserPage } from "../src/server/browser/page.ts";
import { VIEWPORTS } from "../src/server/browser/viewport.ts";
import type { ReviewRound } from "../src/server/docs.ts";
import { createHandler } from "../src/server/http.ts";

const chromium = findBrowser();
const real = {
    skip: chromium === undefined ? "no Chromium-based browser on this machine" : false,
    timeout: 180_000,
} as const;
const CHANGES = '[role="tabpanel"][aria-label="Changes"]';
const LOCAL = `${CHANGES} [aria-label="Local reviews"]`;
const ROUND = `${LOCAL} .rv-selector select`;
const PATH = "src/components/a-long-directory-name-for-phone-review/title.ts";
const FILE = `${CHANGES} .dr-file[data-path="${PATH}"]`;
const CODE = `${FILE} .dv-code`;
const OLD_LINE = `${FILE} [aria-label="Comment on old line 2"]`;
const NEW_LINE = `${FILE} [aria-label="Comment on new line 2"]`;
const TITLE = "Saved headline review";
const OWNER_NOTE = "Owner approves the original saved headline.";
const VIEWER_NOTE = "View-only reviewer requests a clearer headline.";
const OLD_COMMENT = "Why was this original headline removed?";
const REPLY = "It was replaced deliberately; keep this discussion on the old line.";
const NEW_COMMENT = "The replacement headline needs another pass.";
const GENERAL_COMMENT = "General discussion also arrives without reloading.";
const REOPEN_COMMENT = "Discussion can be posted again after the owner reopens.";
const CLOSE_REASON =
    "Closing deliberately while the requested wording change is tracked elsewhere.";
const repo = join(work, "reviews-ui-repo");
const code = (marker: string) =>
    [
        "export function title() {",
        `    return \"${marker}\";`,
        "}",
        "",
        ...Array.from({ length: 20 }, (_, line) => `export const untouched${line} = ${line};`),
        "",
    ].join("\n");

let app: App;
let server: Server;
let browsers: Browsers;
let ownerPage: BrowserPage;
let viewerPage: BrowserPage;
let viewer: ReturnType<App["config"]["addUser"]>;
let session: ConversationId;
let base = "";
const viewerRequests: string[] = [];

async function inPage<T>(on: BrowserPage, script: string): Promise<T> {
    return JSON.parse(await on.evaluate(script)) as T;
}

async function present(on: BrowserPage, selector: string): Promise<boolean> {
    return inPage<boolean>(
        on,
        `
        const element = document.querySelector(${JSON.stringify(selector)});

        return JSON.stringify(!!element && element.getClientRects().length > 0);
    `,
    );
}

async function text(on: BrowserPage, selector: string): Promise<string> {
    return inPage<string>(
        on,
        `
        return JSON.stringify([...document.querySelectorAll(${JSON.stringify(selector)})]
            .map(element => element.innerText).join("\\n"));
    `,
    );
}

async function waitText(on: BrowserPage, selector: string, expected: string): Promise<void> {
    await until(
        async () => (await text(on, selector)).includes(expected),
        `${expected} in ${selector}`,
    );
}

/** Resolve real label/control associations, rather than depending on generated Preact IDs. */
async function field(on: BrowserPage, label: string): Promise<string> {
    let selector = "";

    await until(async () => {
        selector = await inPage<string>(
            on,
            `
            const label = [...document.querySelectorAll("label")]
                .find(element => element.textContent.trim() === ${JSON.stringify(label)});

            return JSON.stringify(label?.control?.id ? "#" + CSS.escape(label.control.id) : "");
        `,
        );

        return selector !== "";
    }, `the labelled field ${label}`);

    return selector;
}

async function rounds(): Promise<ReviewRound[]> {
    const response = await fetch(`${base}/api/c/${session}/reviews`, {
        headers: { Authorization: `Bearer ${viewer.token}` },
    });

    assert.equal(response.status, 200, await response.clone().text());

    return ((await response.json()) as { items: ReviewRound[] }).items;
}

async function selectRound(on: BrowserPage, id: string): Promise<void> {
    await on.select({ selector: ROUND }, id);

    if (id !== "") {
        await waitText(on, `${LOCAL} h3`, TITLE);
    }
}

async function showDiff(on: BrowserPage, marker: string): Promise<void> {
    await until(async () => present(on, FILE), "the changed file");
    // Saved rounds have a long details panel above lazy-loaded diffs; bring the file into view.
    await on.scroll({ selector: FILE });
    await waitText(on, CODE, marker);
}

/** Check the actual form controls at 390x844, including a long line-comment label. */
async function phoneLayout(): Promise<void> {
    const layout = await inPage<{
        width: number;
        height: number;
        pageWidth: number;
        panelLeft: number;
        panelRight: number;
        badControls: string[];
        unnamedControls: string[];
    }>(
        viewerPage,
        `
        const panel = document.querySelector(".files-tile:not(.leaving)").getBoundingClientRect();
        const controls = [...document.querySelectorAll(${JSON.stringify(`${CHANGES} .rv-panel button, ${CHANGES} .rv-panel select, ${CHANGES} .rv-panel textarea, ${CHANGES} .rv-panel summary, ${FILE} .rv-threads button, ${FILE} .rv-threads textarea, ${FILE} .rv-threads summary`)})]
            .filter(element => element.getClientRects().length > 0);
        const name = element => element.getAttribute("aria-label") ||
            [...(element.labels ?? [])].map(label => label.textContent.trim()).join(" ") ||
            element.textContent.trim();

        return JSON.stringify({
            width: innerWidth,
            height: innerHeight,
            pageWidth: document.documentElement.scrollWidth,
            panelLeft: panel.left,
            panelRight: panel.right,
            badControls: controls.filter(element => {
                const rect = element.getBoundingClientRect();

                return rect.width < 1 || rect.left < -1 || rect.right > innerWidth + 1;
            }).map(name),
            unnamedControls: controls.filter(element => !name(element)).map(element => element.tagName),
        });
    `,
    );

    assert.equal(layout.width, 390);
    assert.equal(layout.height, 844);
    assert.ok(layout.pageWidth <= 390, `the review does not widen the page: ${layout.pageWidth}`);
    assert.ok(layout.panelLeft >= -1 && layout.panelRight <= 391, "the Files panel fits the phone");
    assert.deepEqual(layout.badControls, [], "review controls are not clipped sideways");
    assert.deepEqual(layout.unnamedControls, [], "review controls have accessible names");
}

before(async () => {
    if (chromium === undefined) {
        return;
    }

    mkdirSync(join(repo, "src/components/a-long-directory-name-for-phone-review"), {
        recursive: true,
    });
    writeFileSync(join(repo, PATH), code("baseline-headline-marker"));
    const git = (...args: string[]) =>
        execFileSync("git", [
            "-C",
            repo,
            "-c",
            "user.name=Review fixture",
            "-c",
            "user.email=review-fixture@example.test",
            "-c",
            "commit.gpgsign=false",
            ...args,
        ]);

    // This commit belongs only to the generated fixture, never the source checkout.
    git("init", "-q", "-b", "main");
    git("add", ".");
    git("commit", "-qm", "Baseline review fixture");
    writeFileSync(join(repo, PATH), code("saved-headline-marker"));
    app = await openApp(scriptedModel(), join(root, "reviews-ui-data"));
    session = await newSession(app, repo);
    viewer = app.config.addUser("View-only reviewer", "viewer", [String(session)]);
    const auth = new Auth(app.config);
    const handler = createHandler({
        app,
        listen: { host: "127.0.0.1", port: 0 },
        restart: () => {},
    });

    server = createServer((request, response) => {
        if (auth.user(request)?.id === viewer.user.id) {
            viewerRequests.push(request.url ?? "");
        }

        void handler(request, response);
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    base = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
    browsers = new Browsers({
        dataDir: mkdtempSync(join(root, "reviews-ui-browser-")),
        load: async () => undefined,
        save: () => {},
    });
    [ownerPage, viewerPage] = await Promise.all([browsers.open(1), browsers.open(2)]);
    await Promise.all([
        ownerPage.setViewport(VIEWPORTS.desktop),
        viewerPage.setViewport(VIEWPORTS.mobile),
    ]);
    await Promise.all([
        ownerPage.navigate(`${base}/login?token=${encodeURIComponent(app.config.ownerToken)}`),
        viewerPage.navigate(`${base}/login?token=${encodeURIComponent(viewer.token)}`),
    ]);
});

after(async () => {
    await browsers?.closeAll({ final: true });
    server?.closeAllConnections();

    if (server?.listening) {
        await new Promise<void>((resolve) => server.close(() => resolve()));
    }

    await app?.close();
    cleanUp();
});

test(
    "owner and view-only reviewer collaborate live on an immutable Changes round, including on a phone",
    real,
    async () => {
        await Promise.all(
            [ownerPage, viewerPage].map(async (on) => {
                await on.navigate(`${base}/s/${session}`);
                await until(
                    async () => present(on, '.topbar [aria-label="Files"]'),
                    "the Files entry point",
                    20_000,
                );
                await until(
                    async () =>
                        inPage<boolean>(
                            on,
                            `
                return JSON.stringify(document.documentElement.dataset.route === undefined);
            `,
                        ),
                    "the route transition to finish",
                );
                await on.click({ selector: '.topbar [aria-label="Files"]' });
            }),
        );
        await ownerPage.click({ selector: '.files-tabs [role="tab"]:nth-child(2)' });
        await Promise.all(
            [ownerPage, viewerPage].map(async (on) => {
                await until(async () => present(on, ROUND), "the review selector");
                assert.equal(
                    await inPage<string>(
                        on,
                        `return JSON.stringify(document.querySelector(${JSON.stringify(ROUND)}).value)`,
                    ),
                    "",
                    "opening Changes never selects somebody's saved approval automatically",
                );
            }),
        );
        assert.equal(await present(viewerPage, '[role="tabpanel"][aria-label="Files"]'), false);
        assert.equal(await present(viewerPage, `${LOCAL} .rv-selector-row button`), false);
        await waitText(viewerPage, `${ROUND} option`, "Select a saved review");
        await waitText(viewerPage, CHANGES, "Select a review round to read its saved diff.");

        // The second browser is already watching before the owner creates anything; no reloads follow.
        await ownerPage.click({ label: "New review" });
        await ownerPage.type({ selector: await field(ownerPage, "Review title") }, TITLE);
        await ownerPage.click({ label: "Save review" });
        await waitText(viewerPage, `${ROUND} option`, TITLE);
        const saved = (await rounds()).find((round) => round.title === TITLE);

        assert.ok(saved, "the UI saved the round through the real HTTP endpoint");
        await selectRound(viewerPage, saved.id);
        assert.equal(await present(viewerPage, `${LOCAL} .rv-own-verdict`), false);
        await ownerPage.click({ label: "Manage reviewers" });
        await ownerPage.select(
            { selector: await field(ownerPage, "Assign reviewer") },
            viewer.user.id,
        );
        await ownerPage.click({ label: "Assign" });
        await waitText(viewerPage, LOCAL, "Submit your review");
        await viewerPage.click({ label: "Submit your review" });
        await ownerPage.click({ label: "Submit your review" });

        await ownerPage.select({ selector: await field(ownerPage, "Verdict") }, "approved");
        await ownerPage.type({ selector: await field(ownerPage, "Review note") }, OWNER_NOTE);
        await ownerPage.click({ label: "Submit review" });
        await waitText(viewerPage, `${LOCAL} [aria-label="Reviewers"]`, OWNER_NOTE);
        await viewerPage.select(
            { selector: await field(viewerPage, "Verdict") },
            "changes_requested",
        );
        await viewerPage.type({ selector: await field(viewerPage, "Review note") }, VIEWER_NOTE);
        await viewerPage.click({ label: "Submit review" });
        await waitText(ownerPage, `${LOCAL} [aria-label="Reviewers"]`, VIEWER_NOTE);
        await waitText(ownerPage, `${LOCAL} [aria-label="Reviewers"]`, OWNER_NOTE);
        await waitText(viewerPage, `${LOCAL} [aria-label="Reviewers"]`, "Changes requested");

        // Keyboard activation of an old-side line and a phone tap on the new side exercise both gutters.
        await showDiff(ownerPage, "saved-headline-marker");
        await ownerPage.scroll({ selector: OLD_LINE });
        await ownerPage.evaluate(`document.querySelector(${JSON.stringify(OLD_LINE)}).focus()`);
        await ownerPage.press("Enter");
        await ownerPage.type(
            { selector: await field(ownerPage, `Comment on ${PATH} · old line 2`) },
            OLD_COMMENT,
        );
        await ownerPage.click({ selector: `${FILE} .rv-comment-form button[type="submit"]` });
        await showDiff(viewerPage, "saved-headline-marker");
        await waitText(viewerPage, `${FILE} .rv-thread`, OLD_COMMENT);
        await waitText(viewerPage, `${FILE} .rv-location`, `${PATH} · old line 2`);
        await viewerPage.click({ label: `Reply to ${owner(app).name}` });
        await viewerPage.type(
            { selector: await field(viewerPage, `Reply to ${owner(app).name}`) },
            REPLY,
        );
        await viewerPage.click({ selector: `${FILE} .rv-reply-form button[type="submit"]` });
        await waitText(ownerPage, `${FILE} .rv-replies`, REPLY);
        await ownerPage.click({ label: "Resolve thread" });
        await waitText(viewerPage, `${FILE} .rv-thread.resolved > summary`, "old line 2");
        await viewerPage.click({ selector: `${FILE} .rv-thread.resolved > summary` });
        await waitText(viewerPage, `${FILE} .rv-replies`, REPLY);

        await viewerPage.click({ selector: NEW_LINE });
        const newCommentField = await field(viewerPage, `Comment on ${PATH} · new line 2`);

        await phoneLayout();
        await viewerPage.type({ selector: newCommentField }, NEW_COMMENT);
        await viewerPage.click({ selector: `${FILE} .rv-comment-form button[type="submit"]` });
        await waitText(ownerPage, `${FILE} .rv-thread`, NEW_COMMENT);
        await waitText(ownerPage, `${FILE} .rv-location`, `${PATH} · new line 2`);
        await viewerPage.click({ label: "Start discussion" });
        await viewerPage.type(
            { selector: await field(viewerPage, "New discussion") },
            GENERAL_COMMENT,
        );
        await viewerPage.click({ selector: `${LOCAL} .rv-comment-form button[type="submit"]` });
        await waitText(ownerPage, `${LOCAL} [aria-label="General discussion"]`, GENERAL_COMMENT);

        // Load the changed checkout into the same renderer/cache, then return to the approved snapshot.
        writeFileSync(join(repo, PATH), code("later-working-headline-marker"));
        await selectRound(ownerPage, "");
        await ownerPage.click({ selector: `${CHANGES} .dr-summary [aria-label="Refresh"]` });
        await showDiff(ownerPage, "later-working-headline-marker");
        assert.equal(await present(ownerPage, `${LOCAL} .rv-own-verdict`), false);
        await selectRound(ownerPage, saved.id);
        await showDiff(ownerPage, "saved-headline-marker");
        assert.ok(!(await text(ownerPage, CODE)).includes("later-working-headline-marker"));
        await waitText(ownerPage, LOCAL, "Saved approvals do not cover the current files.");
        await waitText(ownerPage, `${LOCAL} [aria-label="Reviewers"]`, OWNER_NOTE);
        // The viewer can deselect/reselect a shared snapshot, but never read the working checkout.
        await selectRound(viewerPage, "");
        await waitText(viewerPage, CHANGES, "Select a review round to read its saved diff.");
        assert.equal(await present(viewerPage, FILE), false);
        await selectRound(viewerPage, saved.id);
        await showDiff(viewerPage, "saved-headline-marker");
        assert.ok(!(await text(viewerPage, CODE)).includes("later-working-headline-marker"));
        await phoneLayout();

        await ownerPage.click({ label: "Close review…" });
        await ownerPage.type(
            { selector: await field(ownerPage, "Close reason (required)") },
            CLOSE_REASON,
        );
        await ownerPage.click({ label: "Close review" });
        await waitText(viewerPage, LOCAL, "Verdicts and discussion are read-only.");

        for (const on of [ownerPage, viewerPage]) {
            assert.equal(
                await present(on, NEW_LINE),
                false,
                "closed diffs have no line-comment action",
            );
            assert.equal(await present(on, `${FILE} [aria-label^="Reply to "]`), false);
            const writable = await inPage<number>(
                on,
                `
            return JSON.stringify([...document.querySelectorAll(${JSON.stringify(`${LOCAL} .rv-own-verdict select, ${LOCAL} .rv-own-verdict textarea, ${LOCAL} .rv-own-verdict button, ${CHANGES} .rv-threads textarea, ${CHANGES} .rv-thread-controls button`)})]
                .filter(element => !element.disabled).length);
        `,
            );

            assert.equal(
                writable,
                0,
                "closed verdict, comment, reply, and resolution controls are read-only",
            );
        }

        await ownerPage.click({ label: "Reopen review" });
        await until(
            async () =>
                !(await inPage<boolean>(
                    viewerPage,
                    `return JSON.stringify(document.querySelector(${JSON.stringify(`${LOCAL} .rv-own-verdict select`)}).disabled)`,
                )),
            "the reopened viewer verdict form",
        );
        await viewerPage.click({ label: "Start discussion" });
        await viewerPage.type(
            { selector: await field(viewerPage, "New discussion") },
            REOPEN_COMMENT,
        );
        await viewerPage.click({ selector: `${LOCAL} .rv-comment-form button[type="submit"]` });
        await waitText(ownerPage, `${LOCAL} [aria-label="General discussion"]`, REOPEN_COMMENT);
        const final = (await rounds()).find((round) => round.id === saved.id)!;

        assert.equal(final.status, "open");
        assert.equal(final.reviewers[owner(app).id]!.state, "approved");
        assert.equal(final.reviewers[owner(app).id]!.text, OWNER_NOTE);
        assert.equal(final.reviewers[viewer.user.id]!.state, "changes_requested");
        assert.equal(final.reviewers[viewer.user.id]!.text, VIEWER_NOTE);
        assert.deepEqual(
            final.threads
                .filter((thread) => thread.path)
                .map((thread) => ({
                    text: thread.text,
                    path: thread.path,
                    side: thread.side,
                    line: thread.line,
                    resolved: thread.resolved,
                    replies: thread.replies.map((reply) => ({
                        userId: reply.userId,
                        text: reply.text,
                    })),
                })),
            [
                {
                    text: OLD_COMMENT,
                    path: PATH,
                    side: "old",
                    line: 2,
                    resolved: true,
                    replies: [{ userId: viewer.user.id, text: REPLY }],
                },
                {
                    text: NEW_COMMENT,
                    path: PATH,
                    side: "new",
                    line: 2,
                    resolved: false,
                    replies: [],
                },
            ],
            "line composers and reply actions transported the selected path, side, line, and author",
        );
        assert.deepEqual(
            viewerRequests.filter((url) =>
                new RegExp(
                    `^/api/c/${session}/(?:changes|files|file|view|edit|lsp)(?:[/?]|$)`,
                ).test(url),
            ),
            [],
            "saved-only viewers never request live workspace content or editor actions",
        );
    },
);
