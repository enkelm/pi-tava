// The persisted-setting contract belongs to ConfigStore, using real isolated files and atomic saves.
// Protects legacy disabled installs, explicit native overrides and rollback after an unwritable save.
// Runtime execution and HTTP authority are owned by session-workflows and agent-settings tests.
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { ConfigStore } from "../src/server/config.ts";

test("native Work Item settings preserve legacy pauses without treating Work Items as an extension", (t) => {
    const directory = mkdtempSync(join(tmpdir(), "coop-work-item-settings-"));

    t.after(() => rmSync(directory, { recursive: true, force: true }));
    const config = new ConfigStore(directory);

    assert.equal(config.workItemsEnabled, true);
    config.setExtensionEnabled("work-items.ts", false);
    config.setExtensionEnabled("browser.ts", false);
    const saved = readFileSync(config.file, "utf8");
    const migrated = new ConfigStore(directory);

    assert.equal(
        migrated.workItemsEnabled,
        false,
        "a saved disabled workflow never silently resumes",
    );
    assert.equal(
        readFileSync(config.file, "utf8"),
        saved,
        "reading migration state does not rewrite settings",
    );
    migrated.workItemsEnabled = true;
    const resumed = new ConfigStore(directory);

    assert.equal(
        resumed.workItemsEnabled,
        true,
        "an explicit native choice supersedes migration input",
    );
    assert.equal(JSON.parse(readFileSync(config.file, "utf8")).workItemsEnabled, true);
    assert.equal(resumed.extensionChoice("browser.ts"), false);
    assert.equal(
        resumed.extensionChoice("work-items.ts"),
        false,
        "legacy input is not an active extension control",
    );
    resumed.workItemsEnabled = false;
    assert.equal(new ConfigStore(directory).workItemsEnabled, false);
});

test("a failed native execution-setting save leaves live and persisted execution paused", (t) => {
    const directory = mkdtempSync(join(tmpdir(), "coop-work-item-save-"));

    t.after(() => rmSync(directory, { recursive: true, force: true }));
    const config = new ConfigStore(directory);

    config.setExtensionEnabled("work-items.ts", false);
    const saved = readFileSync(config.file, "utf8");
    const blockedTemp = `${config.file}.${process.pid}.tmp`;

    mkdirSync(blockedTemp);
    assert.throws(() => {
        config.workItemsEnabled = true;
    });
    assert.equal(config.workItemsEnabled, false);
    assert.equal(readFileSync(config.file, "utf8"), saved);
    assert.equal(new ConfigStore(directory).workItemsEnabled, false);
});
