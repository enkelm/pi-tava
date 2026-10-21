// Real HTTP and two Chromium identities over a generated checkout. Backend tests own review
// authorization, persistence and bounds; this test owns UI transport, inline placement, shared
// navigation and explicit human sending. The only injected failure is one HTTP 503 response.
import {
    type App,
    cleanUp,
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
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { createServer, type Server } from "node:http";
import { join } from "node:path";
import { after, before, test } from "node:test";
import { fauxAssistantMessage } from "@earendil-works/pi-ai/providers/faux";
import type { ConversationId } from "@earendil-works/pi-durable";
import { Auth } from "../src/server/auth.ts";
import { Browsers } from "../src/server/browser.ts";
import { findBrowser } from "../src/server/browser/discovery.ts";
import type { BrowserPage } from "../src/server/browser/page.ts";
import { type Viewport, VIEWPORTS } from "../src/server/browser/viewport.ts";
import type { ChangeReviews } from "../src/server/docs.ts";
import { createHandler } from "../src/server/http.ts";

const chromium = findBrowser();
const real = {
    skip: chromium === undefined ? "no Chromium-based browser on this machine" : false,
    timeout: 180_000,
} as const;
const CHANGES = '[role="tabpanel"][aria-label="Changes"]';
const PATH = "src/components/a-long-directory-name-for-phone-review/title.ts";
const FILE = `${CHANGES} .dr-file[data-path="${PATH}"]`;
const CODE = `${FILE} .dv-code`;
const OLD_LINE = `${FILE} [aria-label="Comment on old line 2"]`;
const NEW_LINE = `${FILE} [aria-label="Comment on new line 2"]`;
const MESSAGE = '[aria-label="Message Pi"]';
const REVIEWS = `${CHANGES} .rv-panel`;
const FORM = `${CHANGES} .rv-form`;
const OLD_COMMENT = "Why was this original headline removed?";
const NEW_COMMENT = "The replacement headline needs another pass.";
const FILE_COMMENT = "Keep the headline helpers together in this file.";
const GENERAL_COMMENT = "Please review the overall wording before shipping.";
const REPLY = "Agreed; use a clearer headline.";
const INLINE_REPLY = "Keep the original meaning when rewriting it.";
const EXISTING_DRAFT = "Keep my existing note.";
const CONTEXT_COMMENT = "This unchanged detail needs the same naming convention.";
const CONTEXT_LINE = `${FILE} [aria-label="Comment on new line 20"]`;
const repo = join(work, "reviews-ui-repo");
const code = (marker: string) =>
    [
        "export function title() {",
        `    return \"${marker}\";`,
        "}",
        "",
        ...Array.from(
            { length: 35 },
            (_, line) => `export const detail${line} = "unchanged detail ${line}";`,
        ),
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
let rejectNextComment = false;
const busy = Promise.withResolvers<void>();
const viewerRequests: string[] = [];
const submissions: string[] = [];
const submittedBodies: { text: string; mode?: string; requestId: string }[] = [];
const modelMessages: string[] = [];

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

async function value(on: BrowserPage, selector: string): Promise<string> {
    return inPage<string>(
        on,
        `return JSON.stringify(document.querySelector(${JSON.stringify(selector)}).value);`,
    );
}

/** Resolve real label/control associations, rather than generated Preact IDs. */
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

async function showDiff(on: BrowserPage, marker: string): Promise<void> {
    await until(async () => present(on, FILE), "the changed file");
    await on.scroll({ selector: FILE });
    await waitText(on, CODE, marker);
}

async function reviews(): Promise<ChangeReviews> {
    const response = await fetch(`${base}/api/c/${session}/reviews`, {
        headers: { Authorization: `Bearer ${viewer.token}` },
    });

    assert.equal(response.status, 200, await response.clone().text());

    return (await response.json()) as ChangeReviews;
}

/** Inline means the composer follows its actual code row, not a form below the whole diff. */
async function inlineComposer(on: BrowserPage, line: string): Promise<void> {
    const placement = await inPage<{ followsRow: boolean; gap: number; insideRow: boolean }>(
        on,
        `
        const row = document.querySelector(${JSON.stringify(line)}).closest("tr");
        const form = document.querySelector(${JSON.stringify(`${FILE} .rv-form`)});
        const annotation = form.closest("tr");

        return JSON.stringify({
            followsRow: row.nextElementSibling === annotation,
            gap: form.getBoundingClientRect().top - row.getBoundingClientRect().bottom,
            insideRow: !!annotation && annotation.parentElement === row.parentElement,
        });
    `,
    );

    assert.equal(placement.followsRow, true, "the comment form directly follows the chosen line");
    assert.equal(
        placement.insideRow,
        true,
        "the composer belongs to the diff, not a detached panel",
    );
    assert.ok(placement.gap >= -1 && placement.gap <= 50, `inline gap: ${placement.gap}`);
}

/** Resizing restarts the window's media-specific entrance animation before real clicks can land. */
async function viewportPanel(on: BrowserPage, viewport: Viewport): Promise<void> {
    await on.setViewport(viewport);
    await until(
        async () =>
            inPage<boolean>(
                on,
                `
            const panel = document.querySelector(".files-tile:not(.leaving)");

            if (!panel || !panel.getClientRects().length) return JSON.stringify(false);

            const before = panel.getBoundingClientRect();

            await new Promise(requestAnimationFrame);
            await new Promise(requestAnimationFrame);

            const after = panel.getBoundingClientRect();
            const moving = panel.getAnimations().some(animation => animation.playState === "running" || animation.pending);

            return JSON.stringify(!moving && innerWidth === ${viewport.width} && innerHeight === ${viewport.height} &&
                after.width > 0 && after.left >= -1 && after.right <= innerWidth + 1 &&
                after.top >= -1 && after.bottom <= innerHeight + 1 &&
                ["left", "right", "top", "bottom"].every(edge => Math.abs(after[edge] - before[edge]) < 0.5));
        `,
            ),
        `the resized Files panel to finish motion and settle inside ${viewport.width}×${viewport.height}`,
    );
}

async function phoneLayout(on: BrowserPage = viewerPage): Promise<void> {
    const layout = await inPage<{
        width: number;
        height: number;
        pageWidth: number;
        panelLeft: number;
        panelRight: number;
        badControls: string[];
        unnamedControls: string[];
        composer: {
            sharedWrapper: boolean;
            containedButtons: boolean;
            postName: string;
            cancelName: string;
            label: string;
        } | null;
    }>(
        on,
        `
        const panel = document.querySelector(".files-tile:not(.leaving)").getBoundingClientRect();
        const controls = [...document.querySelectorAll(${JSON.stringify(`${REVIEWS} button, ${REVIEWS} input, ${REVIEWS} summary, ${CHANGES} .rv-threads button, ${FORM} button, ${FORM} textarea`)})]
            .filter(element => element.getClientRects().length > 0);
        const name = element => element.getAttribute("aria-label") ||
            [...(element.labels ?? [])].map(label => label.textContent.trim()).join(" ") ||
            element.textContent.trim();
        const form = [...document.querySelectorAll(${JSON.stringify(FORM)})]
            .find(element => element.getClientRects().length > 0);
        const input = form?.querySelector("textarea");
        const wrapper = input?.parentElement;
        const post = form?.querySelector('button[type="submit"]');
        const cancel = form?.querySelector('button[aria-label="Cancel"]');
        const contains = (outer, inner) => {
            const box = inner?.getBoundingClientRect();

            return !!box && box.width >= 40 && box.height >= 40 &&
                box.left >= outer.left - 1 && box.right <= outer.right + 1 &&
                box.top >= outer.top - 1 && box.bottom <= outer.bottom + 1;
        };

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
            composer: input ? {
                sharedWrapper: wrapper !== form && wrapper.contains(post) && wrapper.contains(cancel),
                containedButtons: contains(wrapper.getBoundingClientRect(), post) &&
                    contains(wrapper.getBoundingClientRect(), cancel),
                postName: post ? name(post) : "",
                cancelName: cancel ? name(cancel) : "",
                label: name(input),
            } : null,
        });
    `,
    );

    assert.equal(layout.width, 390);
    assert.equal(layout.height, 844);
    assert.ok(layout.pageWidth <= 390, `the review does not widen the page: ${layout.pageWidth}`);
    assert.ok(
        layout.panelLeft >= -1 && layout.panelRight <= 391,
        `the Files panel fits the phone: left=${layout.panelLeft}, right=${layout.panelRight}, viewport=${layout.width}×${layout.height}`,
    );
    assert.deepEqual(layout.badControls, [], "review controls are not clipped sideways");
    assert.deepEqual(layout.unnamedControls, [], "review controls have accessible names");

    if (layout.composer) {
        assert.equal(
            layout.composer.sharedWrapper,
            true,
            "post and cancel share the input wrapper",
        );
        assert.equal(
            layout.composer.containedButtons,
            true,
            "the input wrapper contains both controls",
        );
        assert.equal(
            layout.composer.postName,
            layout.composer.label.startsWith("Reply to ") ? "Post reply" : "Post comment",
        );
        assert.equal(layout.composer.cancelName, "Cancel");
    }
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
            "-c",
            "core.hooksPath=/dev/null",
            ...args,
        ]);

    // Only this generated fixture is committed; neither source checkout nor global Git config changes.
    git("init", "-q", "-b", "main");
    git("add", ".");
    git("commit", "-qm", "Baseline review fixture");
    writeFileSync(join(repo, PATH), code("working-headline-marker"));
    app = await openApp(
        scriptedModel(async (context) => {
            const message = lastText(context).text;

            modelMessages.push(message);

            if (message.includes("Keep working until released")) {
                await busy.promise;
            }

            return fauxAssistantMessage("Review fixture response");
        }),
        join(root, "reviews-ui-data"),
    );
    session = await newSession(app, repo);
    viewer = app.config.addUser("View-only reviewer", "viewer", [String(session)]);
    const auth = new Auth(app.config);
    const handler = createHandler({
        app,
        listen: { host: "127.0.0.1", port: 0 },
        restart: () => {},
    });

    server = createServer((request, response) => {
        const url = request.url ?? "";

        if (auth.user(request)?.id === viewer.user.id) {
            viewerRequests.push(url);
        }

        if (request.method === "POST" && url === `/api/c/${session}/submit`) {
            submissions.push(url);
            let body = "";

            request.on("data", (chunk) => (body += chunk));
            request.on("end", () => submittedBodies.push(JSON.parse(body)));
        }

        if (
            rejectNextComment &&
            request.method === "POST" &&
            url === `/api/c/${session}/reviews/comment`
        ) {
            rejectNextComment = false;
            request.resume();
            response.writeHead(503, { "Content-Type": "application/json" });
            response.end(JSON.stringify({ error: "Temporary review connection failure" }));

            return;
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
    busy.resolve();
    await browsers?.closeAll({ final: true });
    server?.closeAllConnections();

    if (server?.listening) {
        await new Promise<void>((resolve) => server.close(() => resolve()));
    }

    await app?.close();
    cleanUp();
});

test(
    "people comment on live Changes, use compact quick actions and explicitly send scoped or all reviews to Pi",
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
                            `return JSON.stringify(document.documentElement.dataset.route === undefined);`,
                        ),
                    "the route transition to finish",
                );
            }),
        );

        // A real, gated scripted-model turn makes the live busy warning observable without a UI seam.
        await ownerPage.type({ selector: MESSAGE }, "Keep working until released");
        await ownerPage.click({ selector: '.composer [aria-label="Send"]' });
        await until(() => app.isBusy(session), "Pi to start working");
        await ownerPage.type({ selector: MESSAGE }, EXISTING_DRAFT);
        await Promise.all(
            [ownerPage, viewerPage].map((on) =>
                on.click({ selector: '.topbar [aria-label="Files"]' }),
            ),
        );
        await ownerPage.click({ selector: '.files-tabs [role="tab"]:nth-child(2)' });
        await Promise.all(
            [ownerPage, viewerPage].map((on) => showDiff(on, "working-headline-marker")),
        );
        await waitText(viewerPage, REVIEWS, "No comments yet");
        assert.equal(await present(viewerPage, '[role="tabpanel"][aria-label="Files"]'), false);
        assert.doesNotMatch(
            await text(viewerPage, REVIEWS),
            /Edit before sending to Pi/,
            "the compact index omits explanation hints",
        );

        // Both actual gutters work, including keyboard activation, before any review setup exists.
        await ownerPage.scroll({ selector: OLD_LINE });
        await ownerPage.evaluate(`document.querySelector(${JSON.stringify(OLD_LINE)}).focus()`);
        await ownerPage.press("Enter");
        await inlineComposer(ownerPage, OLD_LINE);
        await ownerPage.evaluate(`
            const theme = await import("/theme.js");

            theme.setPrefs({ motion: "reduced" });
            theme.chooseLook("lantern");
        `);
        await until(
            () =>
                inPage<boolean>(
                    ownerPage,
                    `return JSON.stringify(
                document.documentElement.dataset.theme === "lantern" &&
                getComputedStyle(document.documentElement).getPropertyValue("--r-control").trim() === "8px"
            );`,
                ),
            "Lantern loaded in the reviewer’s browser",
        );
        const corners = await inPage<string[]>(
            ownerPage,
            `
            return JSON.stringify([
                document.querySelector(${JSON.stringify(`${FORM} textarea`)}),
                document.querySelector(${JSON.stringify(`${FORM} button[type="submit"]`)}),
                document.querySelector(${JSON.stringify(`${REVIEWS} .rv-disclosure`)}),
            ].map(control => getComputedStyle(control).borderRadius));
        `,
        );

        assert.deepEqual(
            corners,
            ["8px", "8px", "6px"],
            "review fields, action buttons and disclosures follow Lantern’s control and row corners",
        );
        await ownerPage.type(
            { selector: await field(ownerPage, `Comment on ${PATH} · old line 2`) },
            OLD_COMMENT,
        );
        await ownerPage.click({ selector: `${FORM} button[type="submit"]` });
        await waitText(viewerPage, `${FILE} .rv-thread`, OLD_COMMENT);
        await viewerPage.click({ selector: NEW_LINE });
        const draft = await field(viewerPage, `Comment on ${PATH} · new line 2`);

        await inlineComposer(viewerPage, NEW_LINE);
        await waitText(viewerPage, FORM, "these lines may change. You can still comment.");
        await viewerPage.type({ selector: draft }, NEW_COMMENT);
        assert.doesNotMatch(
            await text(viewerPage, FORM),
            /Comments are shared here, not sent to Pi/,
        );
        await phoneLayout();
        rejectNextComment = true;
        await viewerPage.click({ selector: `${FORM} button[type="submit"]` });
        await waitText(viewerPage, `${FORM} [role="alert"]`, "Temporary review connection failure");
        assert.equal(
            await value(viewerPage, draft),
            NEW_COMMENT,
            "a failed post retains the draft",
        );
        await viewerPage.click({ label: "Cancel" });
        await viewerPage.click({ selector: NEW_LINE });
        const retryDraft = await field(viewerPage, `Comment on ${PATH} · new line 2`);

        assert.equal(
            await value(viewerPage, retryDraft),
            NEW_COMMENT,
            "closing and reopening retains the failed draft",
        );
        await viewerPage.click({ selector: `${FORM} button[type="submit"]` });
        await waitText(ownerPage, `${FILE} .rv-thread`, NEW_COMMENT);

        await viewerPage.click({ selector: `${FILE} [aria-label="Comment on ${PATH}"]` });
        const fileDraft = await field(viewerPage, `Comment on ${PATH} · file`);
        const filePlacement = await inPage<{
            headerBottom: number;
            formTop: number;
            formBottom: number;
            tableTop: number;
        }>(
            viewerPage,
            `
            const file = document.querySelector(${JSON.stringify(FILE)});
            const header = file.querySelector(".dv-head");
            const form = file.querySelector(".rv-form");
            const table = file.querySelector("table");

            return JSON.stringify({headerBottom: header.getBoundingClientRect().bottom,
                formTop: form.getBoundingClientRect().top,
                formBottom: form.getBoundingClientRect().bottom,
                tableTop: table.getBoundingClientRect().top});
        `,
        );

        assert.ok(
            filePlacement.headerBottom <= filePlacement.formTop &&
                filePlacement.formBottom <= filePlacement.tableTop,
            `the file composer is between the file header and code rows: ${JSON.stringify(filePlacement)}`,
        );
        await viewerPage.type({ selector: fileDraft }, FILE_COMMENT);
        await viewerPage.click({ selector: `${FORM} button[type="submit"]` });
        await waitText(ownerPage, `${FILE} .rv-thread`, FILE_COMMENT);
        await viewerPage.click({ label: "Comment on all changes" });
        await viewerPage.type(
            { selector: await field(viewerPage, "Comment on All changes") },
            GENERAL_COMMENT,
        );
        await viewerPage.click({ selector: `${FORM} button[type="submit"]` });
        await waitText(ownerPage, `${CHANGES} .rv-thread`, GENERAL_COMMENT);

        const posted = await reviews();
        const newThread = posted.threads.find((thread) => thread.text === NEW_COMMENT)!;
        const oldThread = posted.threads.find((thread) => thread.text === OLD_COMMENT)!;
        const fileThread = posted.threads.find((thread) => thread.text === FILE_COMMENT)!;
        const generalThread = posted.threads.find((thread) => thread.text === GENERAL_COMMENT)!;
        const threadSelector = `#review-thread-${newThread.id}`;
        const oldThreadSelector = `#review-thread-${oldThread.id}`;
        const viewerRow = `${REVIEWS} [data-reviewer="${viewer.user.id}"]`;
        const ownerRow = `${REVIEWS} [data-reviewer="${owner(app).id}"]`;
        const newIndex = `${viewerRow} .rv-index-comment:has(.rv-jump[aria-label$=": ${NEW_COMMENT}"])`;
        const fileIndex = `${viewerRow} .rv-index-comment:has(.rv-jump[aria-label$=": ${FILE_COMMENT}"])`;

        assert.deepEqual(
            posted.threads.map((thread) => ({
                text: thread.text,
                userId: thread.userId,
                path: thread.path,
                side: thread.side,
                line: thread.line,
                context: thread.context,
            })),
            [
                {
                    text: OLD_COMMENT,
                    userId: owner(app).id,
                    path: PATH,
                    side: "old",
                    line: 2,
                    context: '    return "baseline-headline-marker";',
                },
                {
                    text: NEW_COMMENT,
                    userId: viewer.user.id,
                    path: PATH,
                    side: "new",
                    line: 2,
                    context: '    return "working-headline-marker";',
                },
                {
                    text: FILE_COMMENT,
                    userId: viewer.user.id,
                    path: PATH,
                    side: undefined,
                    line: undefined,
                    context: undefined,
                },
                {
                    text: GENERAL_COMMENT,
                    userId: viewer.user.id,
                    path: undefined,
                    side: undefined,
                    line: undefined,
                    context: undefined,
                },
            ],
            "the real forms transport the chosen author, file, side, line and original context",
        );

        for (const [row, person, isOwner] of [
            [ownerRow, owner(app), true],
            [viewerRow, viewer.user, false],
        ] as const) {
            const identity = await inPage<{
                name: string;
                avatarName: string;
                avatarReadable: boolean;
                beforeName: boolean;
                ownerTag: boolean;
            }>(
                viewerPage,
                `
                const header = document.querySelector(${JSON.stringify(`${row} .rv-reviewer-toggle`)});
                const name = header.querySelector(".rv-name");
                const avatar = header.querySelector(".avatar");
                const owner = [...header.querySelectorAll("span")]
                    .find(element => element.textContent.trim() === "Owner");

                return JSON.stringify({
                    name: name?.textContent ?? "",
                    avatarName: avatar?.getAttribute("title") ?? "",
                    avatarReadable: !!avatar?.textContent.trim(),
                    beforeName: !!avatar && !!name &&
                        !!(avatar.compareDocumentPosition(name) & Node.DOCUMENT_POSITION_FOLLOWING) &&
                        avatar.getBoundingClientRect().right <= name.getBoundingClientRect().left + 1,
                    ownerTag: !!owner && owner.getClientRects().length > 0,
                });
            `,
            );

            assert.ok(identity.name.includes(person.name), "the reviewer name remains readable");
            assert.equal(identity.avatarName, person.name, "the avatar identifies its reviewer");
            assert.equal(identity.avatarReadable, true, "the avatar has readable initials");
            assert.equal(identity.beforeName, true, "the avatar precedes the reviewer name");
            assert.equal(identity.ownerTag, isOwner, "only the owner reviewer has an Owner tag");
        }

        assert.equal(
            await present(viewerPage, `${REVIEWS} [aria-label="Send all reviews to Pi"]`),
            false,
            "a viewer cannot send review work to Pi",
        );
        assert.equal(
            await present(
                viewerPage,
                `${viewerRow} [aria-label="Send ${viewer.user.name}'s reviews to Pi"]`,
            ),
            false,
        );

        // Index reply must navigate to this exact thread and open its inline composer, not a new comment.
        await ownerPage.click({ selector: `${viewerRow} .rv-reviewer-toggle` });
        await ownerPage.click({
            selector: `${newIndex} [aria-label="Reply to comment by ${viewer.user.name}: ${NEW_COMMENT}"]`,
        });
        await until(
            async () => present(ownerPage, `${threadSelector}.rv-targeted .rv-form textarea`),
            "quick reply to target the selected thread and open its inline composer",
        );
        assert.equal(
            await inPage<boolean>(
                ownerPage,
                `
                await new Promise(requestAnimationFrame);
                await new Promise(requestAnimationFrame);

                return JSON.stringify(document.activeElement === document.querySelector(
                    ${JSON.stringify(`${threadSelector}.rv-targeted .rv-form textarea`)}));
            `,
            ),
            true,
            "index quick reply leaves keyboard focus in the targeted reply input",
        );
        await ownerPage.type(
            { selector: await field(ownerPage, `Reply to ${viewer.user.name}`) },
            REPLY,
        );
        await ownerPage.click({ selector: `${threadSelector} [aria-label="Post reply"]` });
        await waitText(viewerPage, `${threadSelector} .rv-replies`, REPLY);

        // The inline reply control has its own action: it responds to the owner's different thread.
        await viewerPage.click({
            selector: `${oldThreadSelector} [aria-label="Reply to ${owner(app).name}"]`,
        });
        await viewerPage.type(
            { selector: await field(viewerPage, `Reply to ${owner(app).name}`) },
            INLINE_REPLY,
        );
        await phoneLayout();
        await viewerPage.click({ selector: `${oldThreadSelector} [aria-label="Post reply"]` });
        await waitText(ownerPage, `${oldThreadSelector} .rv-replies`, INLINE_REPLY);
        const replied = await reviews();

        assert.deepEqual(
            replied.threads
                .find((thread) => thread.id === newThread.id)!
                .replies.map((reply) => ({
                    text: reply.text,
                    userId: reply.userId,
                })),
            [{ text: REPLY, userId: owner(app).id }],
            "the index quick reply belongs only to its selected thread",
        );
        assert.deepEqual(
            replied.threads
                .find((thread) => thread.id === oldThread.id)!
                .replies.map((reply) => ({
                    text: reply.text,
                    userId: reply.userId,
                })),
            [{ text: INLINE_REPLY, userId: viewer.user.id }],
            "the inline reply belongs to the other thread",
        );
        assert.equal(
            await inPage<boolean>(
                viewerPage,
                `
            return JSON.stringify(!!document.querySelector(${JSON.stringify(threadSelector)}).closest(".dv-review-row"));
        `,
            ),
            true,
            "matching comment context remains beside its code row",
        );

        // A real checkout edit must not reattach the line-2 feedback to unrelated replacement text.
        writeFileSync(join(repo, PATH), code("later-working-headline-marker"));
        await Promise.all(
            [ownerPage, viewerPage].map(async (on) => {
                await on.click({ selector: `${CHANGES} .dr-summary [aria-label="Refresh"]` });
                await showDiff(on, "later-working-headline-marker");
                await waitText(on, `${FILE} .rv-notice`, "Earlier context");
            }),
        );
        assert.equal(
            await inPage<boolean>(
                viewerPage,
                `
            const thread = document.querySelector(${JSON.stringify(threadSelector)});

            return JSON.stringify(!!thread.closest(".dv-review-row"));
        `,
            ),
            false,
            "changed context is not silently attached to the new contents of line 2",
        );
        assert.equal(
            await present(ownerPage, `${threadSelector} .rv-form`),
            false,
            "a submitted index reply stays closed when its thread moves to earlier context",
        );
        await viewerPage.click({ selector: `${threadSelector} .rv-context summary` });
        await waitText(
            viewerPage,
            `${threadSelector} .rv-context`,
            'return "working-headline-marker";',
        );

        // Reviewer disclosure stays within a sticky index while the long phone diff scrolls.
        await viewerPage.click({ selector: `${viewerRow} .rv-reviewer-toggle` });
        await waitText(viewerPage, `${viewerRow} .rv-comment-index`, GENERAL_COMMENT);
        await phoneLayout();
        await viewerPage.click({ selector: `${REVIEWS} .rv-panel-toggle` });
        assert.equal(await present(viewerPage, `${viewerRow} .rv-jump`), false);
        const pinned = await inPage<{ scroll: number; top: number; bottom: number }>(
            viewerPage,
            `
            const panel = document.querySelector(${JSON.stringify(REVIEWS)});
            let scroller = panel.parentElement;

            while (scroller && !(scroller.scrollHeight > scroller.clientHeight &&
                /auto|scroll/.test(getComputedStyle(scroller).overflowY))) {
                scroller = scroller.parentElement;
            }
            if (!scroller) throw new Error("No scroll container around Reviews");
            scroller.scrollTop = 600;
            await new Promise(requestAnimationFrame);
            const box = panel.getBoundingClientRect();

            return JSON.stringify({ scroll: scroller.scrollTop, top: box.top, bottom: box.bottom });
        `,
        );

        assert.ok(pinned.scroll > 100, "the test actually scrolled the diff");
        assert.ok(
            pinned.top >= 0 && pinned.bottom < 844,
            "collapsed Reviews stays on screen over scrolled code",
        );

        // People is an independent entry point; clicking status must reopen and highlight the right reviewer.
        await ownerPage.click({ selector: ".topbar .people-button" });
        await waitText(ownerPage, ".rv-people", viewer.user.name);
        await ownerPage.click({
            selector: `.rv-people .rv-person-link[aria-label^="Show ${viewer.user.name}"]`,
        });
        await until(
            async () =>
                present(
                    ownerPage,
                    `${viewerRow}.rv-focused .rv-reviewer-toggle[aria-expanded="true"]`,
                ),
            "People opens Changes and expands the selected reviewer",
        );
        await ownerPage.click({ selector: `${viewerRow} .rv-jump` });
        await until(
            async () => present(ownerPage, `${threadSelector}.rv-targeted`),
            "the comment link highlights its actual thread",
        );

        const selected = `${viewerRow} input[aria-label="Select comment by ${viewer.user.name}: ${NEW_COMMENT}"]`;
        const bulkButton = `${viewerRow} .rv-bulk button`;
        const bulkLabel = (count: number) =>
            `Resolve selected comments by ${viewer.user.name} (${count})`;

        assert.equal(await present(ownerPage, bulkButton), false, "no bulk tick before selection");
        assert.equal(
            await present(ownerPage, `${viewerRow} [aria-label^="Resolve all"]`),
            false,
            "there is no separate Resolve all action",
        );
        await ownerPage.click({ selector: `${viewerRow} .rv-select-all input` });
        assert.deepEqual(
            await inPage<string[]>(
                ownerPage,
                `
                return JSON.stringify([...document.querySelectorAll(${JSON.stringify(bulkButton)})]
                    .map(button => button.getAttribute("aria-label")));
            `,
            ),
            [bulkLabel(3)],
            "selecting all shows exactly one labelled bulk tick",
        );
        await ownerPage.click({ selector: `${viewerRow} .rv-select-all input` });
        assert.equal(
            await present(ownerPage, bulkButton),
            false,
            "clearing selection removes the tick",
        );
        await ownerPage.click({ selector: selected });
        await ownerPage.click({ selector: `${bulkButton}[aria-label="${bulkLabel(1)}"]` });
        await waitText(viewerPage, `${threadSelector} .rv-status`, "Resolved");
        assert.equal(
            await present(ownerPage, bulkButton),
            false,
            "resolving clears selection and its tick",
        );
        const partlyResolved = await reviews();

        assert.deepEqual(
            partlyResolved.threads.filter((thread) => thread.resolved).map((thread) => thread.text),
            [NEW_COMMENT],
            "the selected checkbox resolves only its own thread",
        );
        await ownerPage.click({
            selector: `${fileIndex} [aria-label="Resolve comment by ${viewer.user.name}: ${FILE_COMMENT}"]`,
        });
        await waitText(viewerPage, `#review-thread-${fileThread.id} .rv-status`, "Resolved");
        assert.deepEqual(
            (await reviews()).threads
                .filter((thread) => thread.resolved)
                .map((thread) => thread.text),
            [NEW_COMMENT, FILE_COMMENT],
            "index quick resolve changes only that comment, without selecting a batch",
        );
        assert.equal(await present(ownerPage, bulkButton), false);
        await ownerPage.click({
            selector: `#review-thread-${generalThread.id} [aria-label="Resolve comment"]`,
        });
        await waitText(viewerPage, REVIEWS, "1 open · 3 resolved");
        assert.deepEqual(
            (await reviews()).threads
                .filter((thread) => !thread.resolved)
                .map((thread) => thread.text),
            [OLD_COMMENT],
            "inline resolve is independent of the index and bulk actions",
        );

        busy.resolve();
        await until(() => !app.isBusy(session), "Pi to finish the held turn");
        assert.equal(
            submissions.length,
            1,
            "comments, replies and resolutions never submit model work",
        );
        assert.equal(modelMessages.length, 1, "ordinary discussion never reaches the model");
        assert.equal(await value(ownerPage, MESSAGE), EXISTING_DRAFT);

        // A real shared turn update blocks both bot controls until this person takes the wheel.
        for (const action of ["on", "release"]) {
            const response = await fetch(`${base}/api/c/${session}/turns`, {
                method: "POST",
                headers: {
                    Authorization: `Bearer ${app.config.ownerToken}`,
                    "Content-Type": "application/json",
                    "X-Pocket": "1",
                },
                body: JSON.stringify({ action }),
            });

            assert.equal(response.status, 200, await response.text());
        }

        const sendButtons = `${REVIEWS} [aria-label="Send all reviews to Pi"], ${viewerRow} [aria-label="Send ${viewer.user.name}'s reviews to Pi"]`;

        await until(
            async () =>
                inPage<boolean>(
                    ownerPage,
                    `
                const buttons = [...document.querySelectorAll(${JSON.stringify(sendButtons)})];

                return JSON.stringify(buttons.length === 2 && buttons.every(button => button.disabled));
            `,
                ),
            "both review bot buttons to respect the shared driver restriction",
        );
        await ownerPage.click({ selector: `${REVIEWS} [aria-label="Send all reviews to Pi"]` });
        assert.equal(submissions.length, 1, "a disabled review send cannot bypass taking turns");
        await ownerPage.click({ label: "Take the wheel" });
        await until(
            async () =>
                inPage<boolean>(
                    ownerPage,
                    `
                const buttons = [...document.querySelectorAll(${JSON.stringify(sendButtons)})];

                return JSON.stringify(buttons.length === 2 && buttons.every(button => !button.disabled));
            `,
                ),
            "the driver's review send controls to enable",
        );
        await viewportPanel(ownerPage, VIEWPORTS.mobile);
        await phoneLayout(ownerPage);
        await ownerPage.click({
            selector: `${viewerRow} [aria-label="Send ${viewer.user.name}'s reviews to Pi"]`,
        });
        await until(
            () => modelMessages.length === 2,
            "the explicitly scoped review send to reach Pi",
        );
        const scoped = modelMessages[1]!;

        for (const expected of [
            `Reviewer: ${viewer.user.name}`,
            `Reply from ${owner(app).name}:`,
            NEW_COMMENT,
            FILE_COMMENT,
            GENERAL_COMMENT,
            REPLY,
            PATH,
        ]) {
            assert.ok(scoped.includes(expected), `the scoped send contains attributed ${expected}`);
        }

        for (const excluded of [
            `Reviewer: ${owner(app).name}`,
            OLD_COMMENT,
            INLINE_REPLY,
            EXISTING_DRAFT,
        ]) {
            assert.equal(scoped.includes(excluded), false, `the scoped send excludes ${excluded}`);
        }

        assert.equal(
            submissions.length,
            2,
            "the scoped bot button sends once through normal submit",
        );
        assert.equal(submittedBodies[1]!.mode, "followUp");
        assert.equal(
            await value(ownerPage, MESSAGE),
            EXISTING_DRAFT,
            "scoped send preserves the main draft",
        );
        await until(() => !app.isBusy(session), "the scoped review turn to finish");
        await ownerPage.click({ selector: `${REVIEWS} [aria-label="Send all reviews to Pi"]` });
        await until(() => modelMessages.length === 3, "the explicitly all-review send to reach Pi");
        const all = modelMessages[2]!;

        for (const expected of [
            `Reviewer: ${owner(app).name}`,
            `Reviewer: ${viewer.user.name}`,
            `Reply from ${owner(app).name}:`,
            `Reply from ${viewer.user.name}:`,
            OLD_COMMENT,
            NEW_COMMENT,
            FILE_COMMENT,
            GENERAL_COMMENT,
            REPLY,
            INLINE_REPLY,
            PATH,
        ]) {
            assert.ok(
                all.includes(expected),
                `the all-review send contains attributed ${expected}`,
            );
        }

        assert.equal(
            all.includes(EXISTING_DRAFT),
            false,
            "review send does not consume the main draft",
        );
        assert.equal(submissions.length, 3, "only the explicit bot buttons submit review work");
        assert.equal(submittedBodies[2]!.mode, "followUp");
        assert.equal(new Set(submittedBodies.map((body) => body.requestId)).size, 3);
        assert.equal(
            await value(ownerPage, MESSAGE),
            EXISTING_DRAFT,
            "all-review send preserves the main draft",
        );
        // The owner can reveal omitted context, but the viewer must receive that same inline
        // discussion without fetching generic Files or mistaking unchanged code for stale context.
        await until(() => !app.isBusy(session), "the all-review turn to finish");
        await viewportPanel(ownerPage, VIEWPORTS.desktop);
        await showDiff(ownerPage, "later-working-headline-marker");
        assert.equal(
            await present(ownerPage, CONTEXT_LINE),
            false,
            "line 20 starts outside the diff hunk",
        );
        await ownerPage.click({ selector: `${FILE} .dv-gap button` });
        await until(
            async () => present(ownerPage, CONTEXT_LINE),
            "the owner to reveal unchanged line 20",
        );
        await ownerPage.click({ selector: CONTEXT_LINE });
        await inlineComposer(ownerPage, CONTEXT_LINE);
        await ownerPage.type(
            { selector: await field(ownerPage, `Comment on ${PATH} · new line 20`) },
            CONTEXT_COMMENT,
        );
        await ownerPage.click({ selector: `${FORM} button[type="submit"]` });
        await waitText(viewerPage, `${FILE} .rv-thread`, CONTEXT_COMMENT);
        const contextThread = (await reviews()).threads.find(
            (thread) => thread.text === CONTEXT_COMMENT,
        )!;
        const contextSelector = `#review-thread-${contextThread.id}`;

        for (const on of [ownerPage, viewerPage]) {
            const placement = await inPage<{ inline: boolean; line: string; code: string }>(
                on,
                `
                const thread = document.querySelector(${JSON.stringify(contextSelector)});
                const row = thread.closest(".dv-review-row");
                const source = row?.previousElementSibling;

                return JSON.stringify({
                    inline: !!row,
                    line: source?.querySelector('[aria-label="Comment on new line 20"]')?.getAttribute("aria-label") ?? "",
                    code: source?.textContent ?? "",
                });
            `,
            );

            assert.equal(
                placement.inline,
                true,
                `${on === ownerPage ? "owner" : "viewer"} keeps unchanged hidden context inline, not under Earlier context`,
            );
            assert.equal(
                placement.line,
                "Comment on new line 20",
                "the thread follows its numbered context row",
            );
            assert.ok(
                placement.code.includes('export const detail15 = "unchanged detail 15";'),
                "the row contains the actual unchanged source",
            );
        }

        while (await present(viewerPage, "button.notice:not(.leaving)")) {
            await viewerPage.click({ selector: "button.notice:not(.leaving)" });
            await until(
                async () => !(await present(viewerPage, "button.notice.leaving")),
                "dismissed collaboration notices to finish leaving",
            );
        }

        for (const control of [`${REVIEWS} .rv-panel-toggle`, `${ownerRow} .rv-reviewer-toggle`]) {
            if (await present(viewerPage, `${control}[aria-expanded="false"]`)) {
                await viewerPage.click({ selector: control });
            }

            await until(
                async () => present(viewerPage, `${control}[aria-expanded="true"]`),
                `${control} to be expanded for review navigation`,
            );
        }

        await viewerPage.click({
            selector: `${ownerRow} .rv-jump[aria-label$=": ${CONTEXT_COMMENT}"]`,
        });
        await until(
            async () =>
                inPage<boolean>(
                    viewerPage,
                    `
                const target = document.querySelector(${JSON.stringify(`${contextSelector}.rv-targeted`)});
                const index = document.querySelector(${JSON.stringify(REVIEWS)});
                const box = target?.getBoundingClientRect();

                return JSON.stringify(!!box && box.top >= index.getBoundingClientRect().bottom - 1 &&
                    box.bottom <= innerHeight);
            `,
                ),
            "the viewer's unchanged-line thread to be highlighted and visible below Reviews",
        );
        assert.ok(
            viewerRequests.some((url) => url.startsWith(`/api/c/${session}/reviews/context?`)),
            "hidden context uses the scoped review context endpoint",
        );
        assert.ok(
            viewerRequests.some((url) => url === `/api/c/${session}/reviews/changes`),
            "viewer reads scoped live Changes",
        );
        assert.ok(
            viewerRequests.some((url) => url.startsWith(`/api/c/${session}/reviews/diff?`)),
            "viewer reads scoped live diffs",
        );
        assert.equal(
            submissions.length,
            3,
            "later context discussion still never submits model work",
        );
        assert.equal(modelMessages.length, 3);
        assert.deepEqual(
            viewerRequests.filter((url) =>
                new RegExp(
                    `^/api/c/${session}/(?:changes|files|file|view|edit|lsp)(?:[/?]|$)`,
                ).test(url),
            ),
            [],
            "viewers never request generic live Files, Changes or editor endpoints",
        );
    },
);
