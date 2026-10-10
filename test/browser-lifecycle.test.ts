// Single-writer profile ownership across an asynchronous Chromium shutdown.
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { Browsers } from "../src/server/browser.ts";
import { Chromium } from "../src/server/browser/cdp.ts";
import { findBrowser, snapOf } from "../src/server/browser/discovery.ts";

const executable = findBrowser();

test(
    "opening waits for shutdown to release the browser profile before starting another writer",
    {
        skip: !executable || snapOf(executable) !== undefined,
    },
    async (t) => {
        const dir = mkdtempSync(join(tmpdir(), "pi-browser-lifecycle-"));
        const browsers = new Browsers({ dataDir: dir, executable });
        const launch = Chromium.launch;
        const stop = Chromium.prototype.stop;
        const roots = new Map<Chromium, string>();
        let lockedRoot: string | undefined;
        let release!: () => void;
        let began!: () => void;
        const gate = new Promise<void>((resolve) => {
            release = resolve;
        });
        const stopping = new Promise<void>((resolve) => {
            began = resolve;
        });

        // The real child keeps the profile lock while shutdown is deliberately paused.
        t.mock.method(Chromium.prototype, "stop", async function (this: Chromium) {
            const root = roots.get(this);

            if (root === undefined) {
                await stop.call(this);

                return;
            }

            lockedRoot = root;
            began();
            await gate;

            try {
                await stop.call(this);
            } finally {
                lockedRoot = undefined;
            }
        });
        t.mock.method(Chromium, "launch", async (...args: Parameters<typeof launch>) => {
            assert.notEqual(
                args[1],
                lockedRoot,
                "a replacement must not contend for a stopping profile",
            );
            const browser = await launch(...args);

            roots.set(browser, args[1]);

            return browser;
        });

        try {
            await browsers.open(1);
            const closing = browsers.closeAll();

            await stopping;
            const reopening = browsers.open(2);
            // Attach a handler before yielding so the pre-fix launch failure is not an unhandled rejection.
            const result = reopening.then(
                (page) => ({ page }),
                (error: Error) => ({ error }),
            );

            await Promise.resolve();
            release();
            await closing;
            const opened = await result;

            assert.ok(
                "page" in opened,
                "opening must wait, not fail against the old process's profile lock",
            );
            assert.equal(
                opened.page.closed,
                false,
                "the old browser's close event cannot close its replacement",
            );
            assert.equal(browsers.page(2), opened.page);
        } finally {
            release();
            await browsers.closeAll({ final: true });
            rmSync(dir, { recursive: true, force: true });
        }
    },
);
