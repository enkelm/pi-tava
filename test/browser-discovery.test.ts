/** Installed browsers stay preferred; cached downloads are only a usable last fallback. */
import assert from "node:assert/strict";
import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, sep } from "node:path";
import { test } from "node:test";
import { findBrowser } from "../src/server/browser/discovery.ts";

test("installed browsers take precedence over cached downloads, with explicit overrides authoritative", (t) => {
    const root = mkdtempSync(join(tmpdir(), "pi-browser-discovery-"));

    t.after(() => rmSync(root, { recursive: true, force: true }));

    const cache = join(root, "cache");
    const folder = (revision: number) => join(cache, `chromium-${revision}`);
    const native =
        process.platform === "darwin"
            ? ["chrome-mac", "Chromium.app", "Contents", "MacOS", "Chromium"]
            : process.platform === "win32"
              ? ["chrome-win64", "chrome.exe"]
              : ["chrome-linux64", "chrome"];
    const foreign =
        process.platform === "win32"
            ? ["chrome-linux64", "chrome"]
            : ["chrome-win64", "chrome.exe"];

    const executable = (revision: number, parts = native) => {
        const path = join(folder(revision), ...parts);

        mkdirSync(join(path, ".."), { recursive: true });
        writeFileSync(path, "fixture", { mode: 0o755 });
        writeFileSync(join(folder(revision), "INSTALLATION_COMPLETE"), "");

        return path;
    };

    const bin = join(root, "bin");
    const desktop = join(bin, process.platform === "win32" ? "google-chrome.exe" : "google-chrome");

    mkdirSync(bin);
    writeFileSync(desktop, "fixture", { mode: 0o755 });
    const older = executable(10);
    const latest = executable(20);

    if (process.platform === "darwin") {
        const shell = join(cache, "chromium_headless_shell-99");

        mkdirSync(join(shell, "chrome-mac"), { recursive: true });
        writeFileSync(join(shell, "chrome-mac", "headless_shell"), "fixture", { mode: 0o755 });
        writeFileSync(join(shell, "INSTALLATION_COMPLETE"), "");
    }

    const env = { PATH: bin, PLAYWRIGHT_BROWSERS_PATH: cache };
    // A real system installation may precede the fixture on PATH. Neither may be displaced by the cache.
    const selected = findBrowser(env);

    assert.ok(selected);
    assert.ok(
        !selected.startsWith(`${cache}${sep}`),
        "an installed browser must beat cached builds",
    );
    assert.equal(findBrowser(env, { places: [desktop] }), desktop);
    assert.equal(findBrowser(env, { places: [] }), desktop, "PATH also precedes cached downloads");
    assert.equal(findBrowser({ ...env, PI_POCKET_BROWSER: ` ${latest} ` }), latest);
    assert.equal(findBrowser({ ...env, PI_POCKET_BROWSER: join(root, "missing") }), undefined);

    // With no installed browser, only a complete, executable build for this host is a fallback.
    const fallback = { ...env, PATH: "" };

    assert.equal(findBrowser(fallback, { places: [] }), latest);
    mkdirSync(folder(30));
    assert.equal(findBrowser(fallback, { places: [] }), latest);
    executable(30);
    rmSync(join(folder(30), "INSTALLATION_COMPLETE"));
    assert.equal(
        findBrowser(fallback, { places: [] }),
        latest,
        "an extracted executable is not enough before download completion",
    );
    executable(40, foreign);
    assert.equal(findBrowser(fallback, { places: [] }), latest, "ignore other platforms' builds");

    if (process.platform !== "win32") {
        chmodSync(executable(35), 0o644);
        assert.equal(findBrowser(fallback, { places: [] }), latest, "ignore non-executable builds");
    }

    rmSync(folder(20), { recursive: true });
    assert.equal(findBrowser(fallback, { places: [] }), older);
    rmSync(folder(10), { recursive: true });
    assert.equal(
        findBrowser(fallback, { places: [] }),
        undefined,
        "foreign, partial and standalone-shell downloads are not full Chromium fallbacks",
    );
});
