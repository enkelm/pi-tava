/** Profile catalogue/import filesystem contracts; browser/API persistence is covered by integration tests. */
import assert from "node:assert/strict";
import {
    lstatSync,
    mkdirSync,
    mkdtempSync,
    readFileSync,
    readdirSync,
    rmSync,
    symlinkSync,
    truncateSync,
    unlinkSync,
    writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, relative } from "node:path";
import { test, type TestContext } from "node:test";
import { setTimeout as delay } from "node:timers/promises";
import { BrowserError } from "../src/server/browser/cdp.ts";
import { findBrowser } from "../src/server/browser/discovery.ts";
import { BrowserProfiles } from "../src/server/browser/profiles.ts";

const executable = findBrowser();
const skipImports = !executable || process.platform === "win32";

function fixture(t: TestContext) {
    assert.ok(executable, "an installed Chromium-family browser is required");
    const dir = mkdtempSync(join(tmpdir(), "pi-browser-profiles-"));
    const root = join(dir, "source user data");
    const data = join(dir, "app");
    const profile = join(root, "Default");
    const files: Record<string, string> = {
        Preferences: JSON.stringify({
            session: {
                restore_on_startup: 1,
                startup_urls: ["https://private.invalid"],
                custom: 42,
            },
            background_mode: { enabled: true },
            sync: { requested: true, has_setup_completed: true },
            signin: { allowed: true },
            bookmark_bar: { show_on_all_tabs: true },
        }),
        Bookmarks: '{"roots":{"bookmark_bar":{"children":[]}}}',
        History: "generated history bytes",
        Cookies: "generated legacy cookie bytes",
        "Network/Cookies": "generated cookie bytes",
        "Network/Cookies-wal": "generated cookie WAL bytes",
        "Local Storage/leveldb/000003.ldb": "generated local storage bytes",
        "Local Storage/leveldb/LOCK": "lock",
        "IndexedDB/https_example.invalid_0.indexeddb.leveldb/000003.ldb":
            "generated indexeddb bytes",
        "IndexedDB/https_cache.invalid_0.indexeddb.leveldb/000003.ldb": "site named cache",
        "Cache/Cache_Data/data_0": "cache",
        "Code Cache/js/data_0": "cache",
        "GPUCache/data_0": "cache",
        "Service Worker/CacheStorage/data_0": "cache",
        "Extensions/extension-id/script.js": "extension",
        "Local Extension Settings/extension-id/data": "extension storage",
        "Extension State/000003.ldb": "extension state",
        "Sync Data/LevelDB/000003.ldb": "sync state",
        "Sessions/Session_123": "old session",
        "Session Storage/000003.ldb": "session storage",
        "Current Session": "session",
        "Last Tabs": "tabs",
        "Login Data": "passwords",
        "Login Data For Account-wal": "account passwords",
        "Web Data": "autofill",
        "Web Data-journal": "autofill journal",
        "Account Web Data": "account autofill and payments",
        "Account Web Data-wal": "account autofill WAL",
        "Account Web Data-shm": "account autofill shared memory",
    };

    for (const [name, content] of Object.entries(files)) {
        mkdirSync(join(profile, name, ".."), { recursive: true });
        writeFileSync(join(profile, name), content);
    }

    mkdirSync(join(root, "Profile 2"));
    writeFileSync(join(root, "Profile 2", "Preferences"), '{"bookmark_bar":{"other":true}}');
    writeFileSync(
        join(root, "Local State"),
        JSON.stringify({
            os_crypt: { encrypted_key: "generated-key" },
            profile: {
                last_used: "Profile 2",
                info_cache: { Default: { name: "Personal" }, "Profile 2": { name: "Work" } },
            },
        }),
    );
    t.after(() => rmSync(dir, { recursive: true, force: true }));

    return {
        dir,
        root,
        profile,
        data,
        files,
        store: new BrowserProfiles(data),
        options: { path: root, executable },
    };
}

test(
    "Windows refuses import until source-running inspection is supported",
    { skip: process.platform !== "win32" || !executable },
    async (t) => {
        const f = fixture(t);
        const source = (await f.store.discover(f.options))[0]!;

        await assert.rejects(
            f.store.import(source.id),
            (error) =>
                error instanceof BrowserError && /Windows.*not supported/i.test(error.message),
        );
        assert.equal(f.store.current(), undefined);
        assert.throws(() => lstatSync(join(f.data, "browser/imports")), { code: "ENOENT" });
    },
);

/** Independent observation of names, bytes and writable metadata (reads may update atime). */
function snapshot(root: string): Record<string, unknown> {
    const result: Record<string, unknown> = {};

    function walk(path: string): void {
        const s = lstatSync(path);

        result[relative(root, path)] = {
            mode: s.mode,
            mtime: s.mtimeMs,
            ctime: s.ctimeMs,
            bytes: s.isFile() ? readFileSync(path).toString("base64") : undefined,
        };

        if (s.isDirectory()) {
            for (const name of readdirSync(path).sort()) {
                walk(join(path, name));
            }
        }
    }

    walk(root);

    return result;
}

test(
    "custom catalogue imports a private snapshot, sanitizes only copied preferences and persists selection",
    { skip: skipImports },
    async (t) => {
        const f = fixture(t);
        const before = snapshot(f.root);
        const sources = await f.store.discover(f.options);

        assert.deepEqual(
            sources.map((source) => [source.profile, source.label]),
            [
                ["Default", "Personal"],
                ["Profile 2", "Work"],
            ],
        );
        const chosen = sources[0]!;

        assert.equal(chosen.path, f.profile);
        assert.equal(chosen.executable, executable);
        assert.notEqual(chosen.id, chosen.path);
        assert.equal(f.store.current(), undefined);
        const selected = await f.store.import(chosen.id);
        const copy = join(selected.directory, "Default");

        assert.equal(selected.label, "Personal");
        assert.equal(selected.executable, executable);
        assert.equal(
            relative(join(f.data, "browser/imports"), selected.directory).split(/[\\/]/).length,
            1,
        );

        for (const name of [
            "Bookmarks",
            "History",
            "Cookies",
            "Network/Cookies",
            "Network/Cookies-wal",
            "Local Storage/leveldb/000003.ldb",
            "IndexedDB/https_example.invalid_0.indexeddb.leveldb/000003.ldb",
            "IndexedDB/https_cache.invalid_0.indexeddb.leveldb/000003.ldb",
        ]) {
            assert.equal(readFileSync(join(copy, name), "utf8"), f.files[name], name);
        }

        for (const name of [
            "Cache",
            "Code Cache",
            "GPUCache",
            "Service Worker/CacheStorage",
            "Extensions",
            "Local Extension Settings",
            "Extension State",
            "Sync Data",
            "Sessions",
            "Session Storage",
            "Current Session",
            "Last Tabs",
            "Login Data",
            "Login Data For Account-wal",
            "Web Data",
            "Web Data-journal",
            "Account Web Data",
            "Account Web Data-wal",
            "Account Web Data-shm",
            "Local Storage/leveldb/LOCK",
        ]) {
            assert.throws(() => lstatSync(join(copy, name)), { code: "ENOENT" }, name);
        }

        const prefs = JSON.parse(readFileSync(join(copy, "Preferences"), "utf8"));

        assert.deepEqual(prefs.session, { restore_on_startup: 0, startup_urls: [], custom: 42 });
        assert.equal(prefs.background_mode.enabled, false);
        assert.equal(prefs.sync.requested, false);
        assert.equal(prefs.sync.has_setup_completed, false);
        assert.equal(
            prefs.signin.allowed,
            true,
            "preserve browser sign-in policy without forcing account sign-out",
        );
        assert.deepEqual(prefs.bookmark_bar, { show_on_all_tabs: true });
        const state = JSON.parse(readFileSync(join(selected.directory, "Local State"), "utf8"));

        assert.deepEqual(state.os_crypt, { encrypted_key: "generated-key" });
        assert.equal(state.profile.last_used, "Default");
        assert.deepEqual(Object.keys(state.profile.info_cache), ["Default"]);
        assert.deepEqual(
            snapshot(f.root),
            before,
            "source data and writable metadata remain unchanged",
        );

        if (process.platform !== "win32") {
            assert.equal(lstatSync(selected.directory).mode & 0o777, 0o700);
            assert.equal(lstatSync(join(copy, "Network/Cookies")).mode & 0o777, 0o600);
            assert.equal(
                lstatSync(join(f.data, "browser/default-profile.json")).mode & 0o777,
                0o600,
            );
        }

        const restarted = new BrowserProfiles(f.data);

        assert.deepEqual(restarted.current(), selected);
        const metadata = restarted.current()!;

        metadata.directory = "/not-the-import";
        assert.deepEqual(
            restarted.current(),
            selected,
            "callers cannot mutate the persisted selection",
        );
        const direct = await restarted.discover({ path: join(f.root, "Profile 2"), executable });

        assert.deepEqual(
            direct.map((source) => [source.profile, source.label]),
            [["Profile 2", "Work"]],
        );
        const second = await restarted.import(direct[0]!.id);

        assert.notEqual(second.directory, selected.directory);
        assert.deepEqual(
            JSON.parse(readFileSync(join(second.directory, "Default/Preferences"), "utf8"))
                .bookmark_bar,
            { other: true },
        );
        assert.equal(readFileSync(join(copy, "History"), "utf8"), f.files.History);
        restarted.useClean();
        assert.equal(restarted.current(), undefined);
        assert.equal(new BrowserProfiles(f.data).current(), undefined);
        assert.ok(
            lstatSync(selected.directory).isDirectory(),
            "selecting clean does not delete imported data",
        );
        restarted.useClean();
    },
);

test(
    "locks, symlinks, changed metadata, unsafe ids and copy failures preserve the prior selection",
    { skip: skipImports },
    async (t) => {
        const f = fixture(t);
        const initial = (await f.store.discover(f.options))[0]!;
        const selected = await f.store.import(initial.id);
        const pointer = join(f.data, "browser/default-profile.json");
        const saved = readFileSync(pointer, "utf8");
        const imports = readdirSync(join(f.data, "browser/imports"));

        const unchanged = () => {
            assert.deepEqual(f.store.current(), selected);
            assert.equal(readFileSync(pointer, "utf8"), saved);
            assert.deepEqual(
                readdirSync(join(f.data, "browser/imports")),
                imports,
                "failed staging leaves no new imports",
            );
        };

        const rejectImport = async (message: RegExp) => {
            const source = (await f.store.discover(f.options))[0]!;

            await assert.rejects(
                f.store.import(source.id),
                (error) => error instanceof BrowserError && message.test(error.message),
            );
            unchanged();
        };

        await assert.rejects(f.store.import(f.profile), BrowserError);
        await assert.rejects(f.store.import("../../outside"), BrowserError);
        unchanged();

        for (const path of [selected.directory, f.dir]) {
            await assert.rejects(
                f.store.discover({ path, executable }),
                (error) =>
                    error instanceof BrowserError &&
                    /outside the app browser directory/i.test(error.message),
            );
        }

        const importsAlias = join(f.dir, "imports-alias");

        symlinkSync(join(f.data, "browser/imports"), importsAlias, "dir");
        await assert.rejects(
            f.store.discover({
                path: join(
                    importsAlias,
                    relative(join(f.data, "browser/imports"), selected.directory),
                ),
                executable,
            }),
            (error) =>
                error instanceof BrowserError &&
                /outside the app browser directory/i.test(error.message),
        );
        unchanged();
        // Dangling Singleton symlinks must be detected with lstat, not exists/stat.
        symlinkSync(join(f.dir, "absent-browser-lock"), join(f.root, "SingletonLock"));
        await rejectImport(/close.*browser.*locked/i);
        unlinkSync(join(f.root, "SingletonLock"));
        symlinkSync(join(f.root, "Local State"), join(f.profile, "linked-secrets"));
        await rejectImport(/symlink/i);
        unlinkSync(join(f.profile, "linked-secrets"));
        const alias = join(f.dir, "profile-alias");

        symlinkSync(f.profile, alias, "dir");
        await assert.rejects(
            f.store.discover({ path: alias, executable }),
            (error) => error instanceof BrowserError && /symlink/i.test(error.message),
        );
        unchanged();
        await assert.rejects(f.store.discover({ path: f.root }), BrowserError);
        await assert.rejects(
            f.store.discover({ path: "relative-profile", executable }),
            BrowserError,
        );
        await assert.rejects(
            f.store.discover({ path: f.root, executable: join(f.dir, "not-installed") }),
            BrowserError,
        );
        unchanged();
        const source = (await f.store.discover(f.options))[0]!;

        writeFileSync(
            join(f.root, "Local State"),
            '{"profile":{"info_cache":{"Default":{"name":"Renamed"}}}}',
        );
        await assert.rejects(
            f.store.import(source.id),
            (error) => error instanceof BrowserError && /metadata changed/i.test(error.message),
        );
        unchanged();
        truncateSync(join(f.profile, "History"), 2 * 1024 ** 3 + 1);
        await rejectImport(/2 GB/);
        writeFileSync(join(f.profile, "History"), f.files.History!);
        // Invalid copied Preferences fails after staging, without publishing that stage.
        writeFileSync(join(f.profile, "Preferences"), "invalid JSON");
        await rejectImport(/import browser profile/i);
    },
);

test(
    "a source edit during staged copying refuses publication and concurrent selection changes",
    { skip: skipImports },
    async (t) => {
        const f = fixture(t);
        const selected = await f.store.import((await f.store.discover(f.options))[0]!.id);
        const imports = join(f.data, "browser/imports");
        const before = readdirSync(imports);

        writeFileSync(join(f.profile, "ZZZ-large"), "");
        truncateSync(join(f.profile, "ZZZ-large"), 64 * 1024 ** 2);
        const source = (await f.store.discover(f.options))[0]!;
        let finished = false;
        const outcome = f.store.import(source.id).then(
            (value) => {
                finished = true;

                return { value, error: undefined };
            },
            (error) => {
                finished = true;

                return { value: undefined, error };
            },
        );
        let copying = false;
        const deadline = Date.now() + 5000;

        while (!finished && Date.now() < deadline) {
            const stage = readdirSync(imports).find((name) => !before.includes(name));

            if (stage) {
                try {
                    copying = lstatSync(join(imports, stage, "Default/ZZZ-large")).isFile();
                } catch {
                    /* Not created yet. */
                }

                if (copying) {
                    break;
                }
            }

            await delay(1);
        }

        if (copying) {
            assert.throws(() => f.store.useClean(), BrowserError);
            await assert.rejects(
                f.store.import(source.id),
                (error) => error instanceof BrowserError && /in progress/i.test(error.message),
            );
            writeFileSync(join(f.profile, "History"), "changed after this file was copied");
        }

        const result = await outcome;

        assert.ok(copying, "observed a real staged file copy");
        assert.ok(
            result.error instanceof BrowserError &&
                /changed during import/i.test(result.error.message),
        );
        assert.deepEqual(f.store.current(), selected);
        assert.deepEqual(new BrowserProfiles(f.data).current(), selected);
        assert.deepEqual(
            readdirSync(imports),
            before,
            "failed stage is removed, old import retained",
        );
    },
);

test(
    "restart ignores corrupt, external-directory and symlink pointers without touching external data",
    { skip: skipImports },
    async (t) => {
        const f = fixture(t);
        const chosen = (await f.store.discover(f.options))[0]!;
        const selected = await f.store.import(chosen.id);
        const pointer = join(f.data, "browser/default-profile.json");
        const externalBefore = snapshot(f.root);

        for (const value of [
            "invalid JSON",
            JSON.stringify({ ...selected, directory: f.root }),
            JSON.stringify({ ...selected, id: "../escape" }),
        ]) {
            writeFileSync(pointer, value);
            assert.equal(new BrowserProfiles(f.data).current(), undefined);
        }

        unlinkSync(pointer);
        symlinkSync(join(f.root, "Local State"), pointer);
        assert.equal(new BrowserProfiles(f.data).current(), undefined);
        assert.deepEqual(snapshot(f.root), externalBefore);
        unlinkSync(pointer);
        writeFileSync(pointer, JSON.stringify(selected));
        rmSync(selected.directory, { recursive: true });
        symlinkSync(f.root, selected.directory, "dir");
        assert.equal(new BrowserProfiles(f.data).current(), undefined);
    },
);
