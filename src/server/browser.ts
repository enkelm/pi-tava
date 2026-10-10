/**
 * The built-in browser: one headless Chromium on this machine, driven over the DevTools protocol through a pipe, with a
 * page per conversation that Pi (the `browser` tool) and the people in the conversation (the Browser panel) share.
 * People see the page as a stream of JPEG frames and send it taps, scrolls, and keys. The page runs on this machine, not
 * in their own browser: it does not share their app tab or its cookies, and pages only this machine can reach (a dev
 * server on localhost) work from a phone too.
 *
 * By default each conversation has an isolated, temporary browser context. When the owner imports a default profile,
 * pages instead share that copied profile's persistent cookies and storage. A restart closes pages, and each
 * conversation's last address and size come back from its saved state when its page is next opened.
 */
import { COOKIE } from "./auth.ts";
import { BrowserError, Chromium } from "./browser/cdp.ts";
import { findBrowser, profileFolder } from "./browser/discovery.ts";
import { BrowserPage, type BrowserState, type Saved } from "./browser/page.ts";
import { BrowserProfiles } from "./browser/profiles.ts";
import { type Viewport, VIEWPORTS, viewportFrom } from "./browser/viewport.ts";
import { describe } from "./errors.ts";

export type OpenOptions = {
    /** The size of a page that has no saved size. */
    viewport?: Viewport;
    /** Open the saved address again (default), or (false) start blank. */
    restore?: boolean;
    /** Wait for the saved address to load (default), or (false) only start loading it. */
    wait?: boolean;
};

export interface BrowsersOptions {
    /** Where the browser's profile goes: `browser/` in it. */
    dataDir: string;
    /** The browser to run. Undefined finds one; null means there is none (tests). */
    executable?: string | null;
    /** Extra Chromium flags, such as `--no-sandbox` where sandboxes are not available. */
    args?: readonly string[];
    /** A conversation's saved address and size, to open its page again. */
    load?(conversationId: number): Promise<Saved | undefined>;
    /** Called when a page's address or size changed. */
    save?(conversationId: number, saved: Saved): void;
    log?(line: string): void;
    /** A page nobody used or watched for this long closes. */
    idleMs?: number;
}

/**
 * The browser and every conversation's page. The browser starts with the first page and stops a while after the last
 * one closes; pages close after a while unused.
 */
export class Browsers {
    readonly #options: BrowsersOptions;
    readonly profiles: BrowserProfiles;
    #switching = false;
    #executable: string | null | undefined;
    #chromium: Promise<Chromium> | undefined;
    #stopping: Promise<void> | undefined;
    readonly #pages = new Map<number, BrowserPage>();
    readonly #opening = new Map<number, Promise<BrowserPage>>();
    readonly #listeners = new Set<(conversationId: number, state: BrowserState) => void>();
    readonly #observed = new Set<number>();
    readonly #pending = new Map<number, NodeJS.Timeout>();
    readonly #problems = new Map<number, string>();
    readonly #reaper: NodeJS.Timeout;
    #idleSince = Date.now();
    #closing = false;
    /** Counts every closeAll: a page that began opening before one must not open after it. */
    #generation = 0;

    constructor(options: BrowsersOptions) {
        this.#options = options;
        this.profiles = new BrowserProfiles(options.dataDir);
        this.#executable = options.executable;
        this.#reaper = setInterval(() => this.#reap(), 60_000);
        this.#reaper.unref();
    }

    /** The browser this machine has, if any. Looked up once. */
    get executable(): string | undefined {
        const imported = this.profiles.current();

        if (imported !== undefined && this.#options.executable !== null) {
            return imported.executable;
        }

        if (this.#executable === undefined) {
            this.#executable = findBrowser() ?? null;
        }

        return this.#executable ?? undefined;
    }

    get available(): boolean {
        return this.executable !== undefined;
    }

    subscribe(listener: (conversationId: number, state: BrowserState) => void): () => void {
        this.#listeners.add(listener);

        return () => this.#listeners.delete(listener);
    }

    /** A conversation's page as it is now; a closed one has no address. */
    state(conversationId: number): BrowserState {
        this.#observed.add(conversationId);
        const page = this.#pages.get(conversationId);
        const imported = this.profiles.current();
        const profile =
            imported === undefined
                ? {}
                : { sharedProfile: `${imported.browser} · ${imported.label}` };

        if (page !== undefined && !page.closed) {
            return { ...page.state(this.available), ...profile };
        }

        const problem = this.#problems.get(conversationId);

        return {
            available: this.available,
            open: false,
            url: "",
            title: "",
            loading: this.#opening.has(conversationId),
            viewport: { ...VIEWPORTS.desktop },
            preset: "desktop",
            canGoBack: false,
            canGoForward: false,
            errors: 0,
            logs: 0,
            ...(problem === undefined ? {} : { problem }),
            ...profile,
        };
    }

    /** The conversation's page if it is open. */
    page(conversationId: number): BrowserPage | undefined {
        const page = this.#pages.get(conversationId);

        return page === undefined || page.closed ? undefined : page;
    }

    /** Coalesce a page's changes: frames of logs and loads arrive in bursts. */
    #changed(conversationId: number): void {
        if (this.#pending.has(conversationId)) {
            return;
        }

        const timer = setTimeout(() => {
            this.#pending.delete(conversationId);
            const state = this.state(conversationId);

            for (const listener of this.#listeners) {
                listener(conversationId, state);
            }
        }, 120);

        timer.unref();
        this.#pending.set(conversationId, timer);
    }

    async #browser(): Promise<Chromium> {
        while (this.#stopping !== undefined) {
            await this.#stopping;
        }

        const executable = this.executable;

        if (executable === undefined) {
            throw new BrowserError(
                "No Chromium-based browser was found on this machine. Install Chromium or Google Chrome, or set PI_POCKET_BROWSER to a browser's path.",
            );
        }

        if (this.#chromium !== undefined) {
            const pending = this.#chromium;
            const running = await pending.catch(() => undefined);

            // A shutdown may have started while the process was launching.
            if (this.#stopping !== undefined || this.#chromium !== pending) {
                return this.#browser();
            }

            if (running !== undefined && !running.connection.closed) {
                return running;
            }
        }

        if (this.#closing || this.#switching) {
            throw new BrowserError("The browser is stopping or changing profiles.");
        }

        const extra = [
            ...(this.#options.args ?? []),
            ...(process.env.PI_POCKET_BROWSER_ARGS?.split(/\s+/).filter(Boolean) ?? []),
        ];
        const imported = this.profiles.current();
        const launching = Chromium.launch(
            executable,
            imported?.directory ?? profileFolder(executable, this.#options.dataDir),
            extra,
            {
                nativeCredentials: imported !== undefined,
                ...(imported === undefined ? {} : { stripCookies: [COOKIE] }),
            },
        );

        this.#chromium = launching;
        launching.catch(() => {
            if (this.#chromium === launching) {
                this.#chromium = undefined;
            }
        });
        const chromium = await launching;

        // The server began stopping while the browser started: nothing will stop this one later.
        if (this.#closing) {
            chromium.kill();

            throw new BrowserError("The server is stopping.");
        }

        this.#options.log?.(`Browser started: ${executable}`);

        chromium.connection.onEvent = (method, params) => {
            if (this.#chromium !== launching || !method.startsWith("Target.")) {
                return;
            }

            const info =
                params.targetInfo ??
                (method === "Target.targetDestroyed" ? { targetId: params.targetId } : undefined);

            if (info === undefined) {
                return;
            }

            for (const [id, page] of this.#pages) {
                // A page closed by its own script (window.close()) is gone, with its browser context.
                if (method === "Target.targetDestroyed" && info.targetId === page.targetId) {
                    void this.#discard(id, page);
                } else {
                    page.targetEvent(method, info);
                }
            }
        };

        chromium.connection.onClose = () => {
            if (this.#chromium !== launching) {
                return;
            }

            this.#chromium = undefined;

            for (const page of this.#pages.values()) {
                page.close();
            }
        };

        return chromium;
    }

    /**
     * The conversation's page, opened (and its saved address loaded again) if it was not. `viewport` sizes a page that
     * has no saved size.
     */
    async open(conversationId: number, options: OpenOptions = {}): Promise<BrowserPage> {
        if (this.#closing) {
            throw new BrowserError("The server is stopping.");
        }

        if (this.#switching) {
            throw new BrowserError("The default browser profile is changing. Try again shortly.");
        }

        const open = this.page(conversationId);

        if (open !== undefined) {
            return open;
        }

        const opening = this.#opening.get(conversationId);

        if (opening !== undefined) {
            return opening;
        }

        const created = this.#create(conversationId, options);

        this.#opening.set(conversationId, created);
        this.#changed(conversationId);

        try {
            const page = await created;

            this.#problems.delete(conversationId);

            return page;
        } catch (error) {
            this.#problems.set(conversationId, describe(error));

            throw error;
        } finally {
            this.#opening.delete(conversationId);
            this.#changed(conversationId);
        }
    }

    async #create(conversationId: number, options: OpenOptions): Promise<BrowserPage> {
        const generation = this.#generation;
        const stale = () => this.#closing || this.#generation !== generation;
        const saved = await this.#options.load?.(conversationId).catch(() => undefined);

        if (stale()) {
            throw new BrowserError("The browser was closed.");
        }

        const chromium = await this.#browser();

        if (stale()) {
            throw new BrowserError("The browser was closed.");
        }

        const connection = chromium.connection;
        const browserContextId: string | undefined =
            this.profiles.current() === undefined
                ? (await connection.send("Target.createBrowserContext", { disposeOnDetach: false }))
                      .browserContextId
                : undefined;
        let page: BrowserPage | undefined;
        let targetId: string | undefined;

        try {
            await connection
                .send("Browser.setDownloadBehavior", { behavior: "deny", browserContextId })
                .catch(() => {});
            ({ targetId } = await connection.send("Target.createTarget", {
                url: "about:blank",
                browserContextId,
            }));
            const { sessionId } = await connection.send("Target.attachToTarget", {
                targetId,
                flatten: true,
            });

            page = new BrowserPage({
                conversationId,
                connection,
                session: sessionId,
                target: targetId!,
                context: browserContextId,
                userAgent: chromium.userAgent,
                viewport: viewportFrom(saved?.viewport) ??
                    options.viewport ?? { ...VIEWPORTS.desktop },
                changed: () => this.#changed(conversationId),
                saved: (value) => this.#options.save?.(conversationId, value),
            });
            await page.init();

            if (stale()) {
                page.close();

                throw new BrowserError("The browser was closed.");
            }

            this.#pages.set(conversationId, page);
            this.#idleSince = Date.now();

            if (options.restore !== false && saved?.url !== undefined && saved.url !== "") {
                const restoring = page.navigate(saved.url, { timeoutMs: 15_000 }).catch(() => {});

                if (options.wait !== false) {
                    await restoring;
                }
            }

            return page;
        } catch (error) {
            page?.close();

            if (browserContextId !== undefined) {
                void connection
                    .send("Target.disposeBrowserContext", { browserContextId })
                    .catch(() => {});
            } else if (targetId !== undefined) {
                void connection.send("Target.closeTarget", { targetId }).catch(() => {});
            }

            throw error;
        }
    }

    /** Close a conversation's page. Its saved address stays, to open it again later. */
    async close(conversationId: number): Promise<void> {
        const page = this.#pages.get(conversationId);

        if (page !== undefined) {
            await this.#discard(conversationId, page);
        }
    }

    /** Forget a page and free its browser context, which holds its cookies and storage. */
    async #discard(conversationId: number, page: BrowserPage): Promise<void> {
        if (this.#pages.get(conversationId) === page) {
            this.#pages.delete(conversationId);
        }

        page.close();

        if (this.#pages.size === 0) {
            this.#idleSince = Date.now();
        }

        this.#changed(conversationId);
        const chromium = await this.#chromium?.catch(() => undefined);

        await chromium?.connection
            .send(
                page.contextId === undefined
                    ? "Target.closeTarget"
                    : "Target.disposeBrowserContext",
                page.contextId === undefined
                    ? { targetId: page.targetId }
                    : { browserContextId: page.contextId },
            )
            .catch(() => {});
    }

    #reap(): void {
        const idle = this.#options.idleMs ?? 30 * 60_000;

        for (const [id, page] of this.#pages) {
            if (page.closed || Date.now() - page.usedAt > idle) {
                void this.#discard(id, page);
            }
        }

        // The browser itself stops a few minutes after its last page closed.
        if (
            this.#pages.size === 0 &&
            this.#opening.size === 0 &&
            this.#chromium !== undefined &&
            Date.now() - this.#idleSince > 5 * 60_000
        ) {
            void this.#stopBrowser();
        }
    }

    #stopBrowser(): Promise<void> {
        if (this.#stopping !== undefined) {
            return this.#stopping;
        }

        const pending = this.#chromium;

        if (pending === undefined) {
            return Promise.resolve();
        }

        const stopping = pending
            .catch(() => undefined)
            .then(async (chromium) => {
                await chromium?.stop();
            })
            .finally(() => {
                if (this.#chromium === pending) {
                    this.#chromium = undefined;
                }

                if (this.#stopping === stopping) {
                    this.#stopping = undefined;
                }
            });

        this.#stopping = stopping;

        return stopping;
    }

    /** Changing the app-wide profile closes all pages; no opening can overlap the switch. */
    async setDefaultProfile(id: string | null): Promise<void> {
        if (this.#switching || this.#closing) {
            throw new BrowserError("The browser is busy changing profiles or stopping.");
        }

        this.#switching = true;

        try {
            await this.closeAll();
            await Promise.allSettled([...this.#opening.values()]);

            if (this.#closing) {
                throw new BrowserError("The server is stopping.");
            }

            if (id === null) {
                this.profiles.useClean();
            } else {
                await this.profiles.import(id);
            }

            this.#problems.clear();
        } finally {
            this.#switching = false;

            for (const conversationId of this.#observed) {
                this.#changed(conversationId);
            }
        }
    }

    /** Close every page and stop the browser, as the server stops or the browser is turned off. */
    async closeAll(options: { final?: boolean } = {}): Promise<void> {
        this.#generation++;

        if (options.final === true) {
            this.#closing = true;
            clearInterval(this.#reaper);
        }

        const ids = [...this.#pages.keys()];

        for (const page of this.#pages.values()) {
            page.close();
        }

        this.#pages.clear();

        if (options.final === true) {
            // After the pages closed, which announces them: nobody listens any more.
            for (const timer of this.#pending.values()) {
                clearTimeout(timer);
            }

            this.#pending.clear();
        }

        await this.#stopBrowser();

        if (options.final !== true) {
            for (const id of ids) {
                this.#changed(id);
            }
        }
    }
}
