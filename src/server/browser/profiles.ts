/** Read-only browser profile discovery and private, bounded snapshots for the app's default browser. */
import { execFile } from "node:child_process";
import { randomUUID } from "node:crypto";
import {
    constants,
    createWriteStream,
    lstatSync,
    mkdirSync,
    readFileSync,
    renameSync,
    rmSync,
    unlinkSync,
    writeFileSync,
    type Stats,
} from "node:fs";
import { access, lstat, mkdir, open, readdir, realpath } from "node:fs/promises";
import { homedir } from "node:os";
import { basename, delimiter, dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { pipeline } from "node:stream/promises";
import { promisify } from "node:util";
import { BrowserError } from "./cdp.ts";
import { snapOf } from "./discovery.ts";

export interface SourceProfile {
    id: string;
    label: string;
    browser: string;
    profile: string;
    path: string;
    executable: string;
}

export interface ImportedProfile {
    id: string;
    label: string;
    browser: string;
    executable: string;
    /** User-data launch root, with the chosen profile copied to Default. */
    directory: string;
}

type Entry = { name: string; stat: Stats };
type Source = { public: SourceProfile; root: string; metadata: string; standard: boolean };
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const PROFILE = /^(Default|Profile \d+)$/;
const MAX_BYTES = 2 * 1024 ** 3;
const MAX_FILES = 100_000;
const MAX_STATE = 16 * 1024 ** 2;
const run = promisify(execFile);
const stamp = (s: Stats) => [s.dev, s.ino, s.mode, s.size, s.mtimeMs, s.ctimeMs].join(":");

function fail(message: string): never {
    throw new BrowserError(message);
}

/** Resolve even a not-yet-created destination through its existing parents. */
async function canonical(path: string): Promise<string> {
    try {
        return await realpath(path);
    } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
            throw error;
        }

        return join(await canonical(dirname(path)), basename(path));
    }
}

function within(parent: string, path: string): boolean {
    const name = relative(parent, path);

    return name !== ".." && !name.startsWith(`..${sep}`) && !isAbsolute(name);
}

/** Exclude password/payment databases, extensions, locks, caches and previously open tabs. */
function excluded(name: string): boolean {
    return (
        /^(Cache|Cache_Data|CacheStorage|Code Cache|GPUCache|Dawn.*Cache|GrShaderCache|ShaderCache|ScriptCache|Media Cache)$/i.test(
            name,
        ) ||
        /^Singleton|^LOCK$|^lockfile$|^\.org\.chromium\.|^Crashpad$|^BrowserMetrics/i.test(name) ||
        /^(Extensions|Extension .*|.* Extension Settings|Sessions|Session Storage|Current (Session|Tabs)|Last (Session|Tabs))$/i.test(
            name,
        ) ||
        /^(Login Data|(?:Account )?Web Data)(?:$|[-. ])/i.test(name) ||
        /^Sync Data$/i.test(name)
    );
}

async function stat(path: string): Promise<Stats | undefined> {
    try {
        return await lstat(path);
    } catch (error) {
        if ((error as NodeJS.ErrnoException).code === "ENOENT") {
            return undefined;
        }

        throw error;
    }
}

async function directory(path: string): Promise<void> {
    const s = await stat(path);

    if (!s?.isDirectory() || s.isSymbolicLink()) {
        fail("Profile directories must be real directories, not symlinks.");
    }
}

async function installed(path: string): Promise<boolean> {
    try {
        await access(path, process.platform === "win32" ? constants.F_OK : constants.X_OK);

        return (await lstat(await realpath(path))).isFile();
    } catch {
        return false;
    }
}

/** Only Local State and directory names are read during discovery. */
async function localState(root: string): Promise<{ json: Record<string, any>; signature: string }> {
    const path = join(root, "Local State");
    const s = await stat(path);

    if (s === undefined) {
        return { json: {}, signature: "absent" };
    }

    if (!s.isFile() || s.isSymbolicLink() || s.size > MAX_STATE) {
        fail("Invalid or oversized Local State metadata.");
    }

    const file = await open(
        path,
        constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0) | (constants.O_NONBLOCK ?? 0),
    );

    try {
        if (stamp(await file.stat()) !== stamp(s)) {
            fail("Profile metadata changed. Close the source browser first, then discover again.");
        }

        const bytes = Buffer.alloc(s.size);
        let at = 0;

        while (at < bytes.length) {
            const { bytesRead } = await file.read(bytes, at, bytes.length - at, at);

            if (bytesRead === 0) {
                fail("Profile metadata changed while reading.");
            }

            at += bytesRead;
        }

        const json = JSON.parse(bytes.toString("utf8"));

        if (json === null || typeof json !== "object" || Array.isArray(json)) {
            fail("Invalid Local State metadata.");
        }

        if (stamp(await file.stat()) !== stamp(s) || stamp(await lstat(path)) !== stamp(s)) {
            fail("Profile metadata changed. Close the source browser first.");
        }

        return { json, signature: stamp(s) };
    } finally {
        await file.close();
    }
}

async function metadata(root: string, path: string): Promise<string> {
    await directory(root);
    await directory(path);

    return [
        stamp(await lstat(root)),
        stamp(await lstat(path)),
        (await localState(root)).signature,
    ].join("|");
}

/** Browser-specific roots are paired with that browser's executable, never a generic fallback. */
function places(): { browser: string; root: string; executables: string[] }[] {
    // macOS app/root and Linux root. Windows roots normally match macOS vendor directories.
    const families = [
        ["Google Chrome", "Google/Chrome", "google-chrome"],
        ["Google Chrome Beta", "Google/Chrome Beta", "google-chrome-beta"],
        ["Google Chrome Dev", "Google/Chrome Dev", "google-chrome-unstable"],
        ["Google Chrome Canary", "Google/Chrome Canary", ""],
        ["Chromium", "Chromium", "chromium"],
        ["Brave Browser", "BraveSoftware/Brave-Browser", "BraveSoftware/Brave-Browser"],
        ["Microsoft Edge", "Microsoft Edge", "microsoft-edge"],
        ["Vivaldi", "Vivaldi", "vivaldi"],
    ];
    const found: ReturnType<typeof places> = [];

    for (const [app, mac, linux] of families) {
        const browser = app!;
        const windows =
            app === "Microsoft Edge"
                ? "Microsoft/Edge"
                : app?.endsWith("Canary")
                  ? "Google/Chrome SxS"
                  : mac!;
        const exe =
            app === "Microsoft Edge"
                ? "msedge"
                : app === "Brave Browser"
                  ? "brave"
                  : app === "Vivaldi"
                    ? "vivaldi"
                    : "chrome";

        if (process.platform === "darwin") {
            found.push({
                browser: browser!,
                root: join(homedir(), "Library/Application Support", mac!),
                executables: ["/Applications", join(homedir(), "Applications")].map((base) =>
                    join(base, `${app}.app/Contents/MacOS`, app!),
                ),
            });
        } else if (process.platform === "win32") {
            found.push({
                browser: browser!,
                root: join(process.env.LOCALAPPDATA ?? homedir(), windows!, "User Data"),
                executables: [
                    process.env.PROGRAMFILES,
                    process.env["PROGRAMFILES(X86)"],
                    process.env.LOCALAPPDATA,
                ]
                    .filter((base): base is string => !!base)
                    .map((base) => join(base, windows!, "Application", `${exe}.exe`)),
            });
        } else if (linux) {
            const commands =
                browser === "Brave Browser"
                    ? ["brave-browser", "brave"]
                    : [linux, `${linux}-stable`];

            if (browser === "Chromium") {
                commands.push("chromium-browser");
            }

            const executables = (process.env.PATH ?? "")
                .split(delimiter)
                .filter(Boolean)
                .flatMap((base) => commands.map((command) => join(base, command)));

            if (browser === "Chromium") {
                executables.unshift("/usr/lib/chromium/chromium");
            }

            found.push({
                browser: browser!,
                root: join(process.env.XDG_CONFIG_HOME ?? join(homedir(), ".config"), linux),
                executables,
            });
        }
    }

    return found;
}

async function unlocked(source: Source): Promise<void> {
    for (const root of new Set([source.root, source.public.path])) {
        for (const name of ["SingletonLock", "SingletonCookie", "SingletonSocket", "lockfile"]) {
            if (await stat(join(root, name))) {
                fail("Close the source browser first: its profile is locked.");
            }
        }
    }

    if (process.platform === "win32") {
        fail(
            "Profile import on Windows is not supported yet: cannot verify the source browser is closed.",
        );
    }

    let output: string;

    try {
        output = (
            await run("ps", ["-axww", "-o", "pid=,args="], {
                timeout: 5000,
                maxBuffer: 8 * 1024 ** 2,
            })
        ).stdout;
    } catch {
        fail("Cannot verify the source browser is closed: process inspection failed.");
    }

    if (!output.trim()) {
        fail(
            "Cannot verify the source browser is closed: process inspection returned no processes.",
        );
    }

    const executable = source.public.executable;
    const resolvedExecutable = await realpath(executable);
    const roots = [source.root, await realpath(source.root)]
        .map((root) => root.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"))
        .join("|");
    const flag = new RegExp(`--user-data-dir(?:=|\\s+)["']?(?:${roots})(?=["'\\s]|$)`);

    for (const line of output.split("\n")) {
        const command = line.trim().replace(/^\d+\s+/, "");

        if (command.includes("--type=")) {
            continue;
        }

        if (
            ![executable, resolvedExecutable, basename(executable)].some(
                (name) => command === name || command.startsWith(`${name} `),
            )
        ) {
            continue;
        }

        if (command.includes("--user-data-dir")) {
            // Other user-data roots (including the app's copy) are not the source browser.
            if (!flag.test(command)) {
                continue;
            }
        } else if (!source.standard) {
            continue;
        }

        fail("Close the source browser first: it is still running.");
    }
}

async function inventory(root: string): Promise<Entry[]> {
    const entries: Entry[] = [];
    let bytes = 0;
    let count = 0;

    async function walk(folder: string, depth: number): Promise<void> {
        if (depth > 64) {
            fail("Profile directory nesting is too deep.");
        }

        for (const name of (await readdir(join(root, folder))).sort()) {
            const relative = join(folder, name);
            const s = await lstat(join(root, relative));

            if (++count > MAX_FILES) {
                fail("Profile exceeds the 100,000 file limit.");
            }

            if (s.isSymbolicLink()) {
                fail("Profile symlinks are not supported.");
            }

            if (excluded(name)) {
                continue;
            }

            if (!s.isDirectory() && !s.isFile()) {
                fail("Profile contains an unsupported special file.");
            }

            bytes += s.isFile() ? s.size : 0;

            if (bytes > MAX_BYTES - MAX_STATE) {
                fail("Profile exceeds the 2 GB import limit.");
            }

            entries.push({ name: relative, stat: s });

            if (s.isDirectory()) {
                await walk(relative, depth + 1);
            }
        }
    }

    await walk("", 0);

    return entries;
}

async function copy(source: string, target: string, entry: Entry): Promise<void> {
    const input = await open(
        join(source, entry.name),
        constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0) | (constants.O_NONBLOCK ?? 0),
    );

    try {
        if (stamp(await input.stat()) !== stamp(entry.stat)) {
            fail("Profile changed. Close the source browser first.");
        }

        const destination = join(target, entry.name);

        if (entry.stat.size === 0) {
            writeFileSync(destination, "", { flag: "wx", mode: 0o600 });
        } else {
            await pipeline(
                input.createReadStream({ autoClose: false, start: 0, end: entry.stat.size - 1 }),
                createWriteStream(destination, { flags: "wx", mode: 0o600 }),
            );
        }

        if (
            stamp(await input.stat()) !== stamp(entry.stat) ||
            stamp(await lstat(join(source, entry.name))) !== stamp(entry.stat)
        ) {
            fail("Profile changed during import. Close the source browser first.");
        }
    } finally {
        await input.close();
    }
}

export class BrowserProfiles {
    readonly #base: string;
    readonly #imports: string;
    readonly #pointer: string;
    #sources = new Map<string, Source>();
    #current: ImportedProfile | undefined;
    #busy = false;

    constructor(dataDir: string) {
        this.#base = join(resolve(dataDir), "browser");
        this.#imports = join(this.#base, "imports");
        this.#pointer = join(this.#base, "default-profile.json");

        try {
            for (const path of [this.#base, this.#imports, this.#pointer]) {
                if (lstatSync(path).isSymbolicLink()) {
                    return;
                }
            }

            const pointer = lstatSync(this.#pointer);

            if (!pointer.isFile() || pointer.size > 64 * 1024) {
                return;
            }

            const value = JSON.parse(readFileSync(this.#pointer, "utf8"));

            if (
                !value ||
                !["id", "label", "browser", "executable", "directory"].every(
                    (key) => typeof value[key] === "string",
                )
            ) {
                return;
            }

            if (
                !UUID.test(value.id) ||
                !UUID.test(basename(value.directory)) ||
                value.directory !== join(this.#imports, basename(value.directory)) ||
                !isAbsolute(value.executable)
            ) {
                return;
            }

            for (const path of [value.directory, join(value.directory, "Default")]) {
                const s = lstatSync(path);

                if (!s.isDirectory() || s.isSymbolicLink()) {
                    return;
                }
            }

            this.#current = {
                id: value.id,
                label: value.label,
                browser: value.browser,
                executable: value.executable,
                directory: value.directory,
            };
        } catch {
            /* Missing or invalid pointers mean a clean profile, never an external path. */
        }
    }

    async #outside(root: string): Promise<void> {
        const source = await realpath(root);
        const destination = await canonical(this.#base);

        if (within(source, destination) || within(destination, source)) {
            fail(
                "Source profiles must be outside the app browser directory and must not contain it.",
            );
        }
    }

    current(): ImportedProfile | undefined {
        return this.#current && { ...this.#current };
    }

    async discover(options: { path?: string; executable?: string } = {}): Promise<SourceProfile[]> {
        try {
            const locations = places();
            const custom = options.path !== undefined;

            if (
                custom &&
                (!isAbsolute(options.path!) ||
                    !options.executable ||
                    !isAbsolute(options.executable) ||
                    !(await installed(options.executable)))
            ) {
                fail(
                    "Custom profiles require an absolute path and an installed browser executable.",
                );
            }

            if (!custom && options.executable !== undefined) {
                fail("Supply a profile path with a custom executable.");
            }

            const candidates = custom
                ? [
                      {
                          browser: basename(options.executable!),
                          root: resolve(options.path!),
                          executables: [options.executable!],
                      },
                  ]
                : locations;
            const sources = new Map<string, Source>();

            for (const candidate of candidates) {
                const executable = (
                    await Promise.all(
                        candidate.executables.map(async (path) =>
                            (await installed(path)) ? path : undefined,
                        ),
                    )
                ).find(Boolean);

                if (!executable || !(await stat(candidate.root))) {
                    if (custom) {
                        fail("Profile path does not exist.");
                    }

                    continue;
                }

                try {
                    await directory(candidate.root);
                    const direct =
                        custom &&
                        (PROFILE.test(basename(candidate.root)) ||
                            (await stat(join(candidate.root, "Preferences")))?.isFile());
                    const root = direct ? dirname(candidate.root) : candidate.root;

                    await directory(root);
                    await this.#outside(root);
                    const state = await localState(root);
                    const names = direct
                        ? [basename(candidate.root)]
                        : (await readdir(root)).filter((name) => PROFILE.test(name));

                    for (const profile of names.sort()) {
                        const path = join(root, profile);

                        await directory(path);
                        const label = state.json.profile?.info_cache?.[profile]?.name;
                        const publicProfile = {
                            id: randomUUID(),
                            label: typeof label === "string" ? label.slice(0, 200) : profile,
                            browser: candidate.browser,
                            profile,
                            path,
                            executable,
                        };

                        sources.set(publicProfile.id, {
                            public: publicProfile,
                            root,
                            metadata: await metadata(root, path),
                            standard: locations.some(
                                (location) => resolve(location.root) === resolve(root),
                            ),
                        });
                    }
                } catch (error) {
                    if (custom) {
                        throw error;
                    }
                }
            }

            if (custom && sources.size === 0) {
                fail("No Chromium profiles found at that path.");
            }

            this.#sources = sources;

            return [...sources.values()].map((source) => ({ ...source.public }));
        } catch (error) {
            throw error instanceof BrowserError
                ? error
                : new BrowserError(
                      `Could not discover browser profiles: ${(error as Error).message}`,
                  );
        }
    }

    async import(id: string): Promise<ImportedProfile> {
        const source = this.#sources.get(id);

        if (!source) {
            fail("Unknown profile selection. Discover profiles again.");
        }

        if (this.#busy) {
            fail("A browser profile import is already in progress.");
        }

        this.#busy = true;
        let stage: string | undefined;

        try {
            if (snapOf(source.public.executable) !== undefined) {
                fail(
                    "Snap browsers cannot launch private imported profiles. Use a non-snap browser installation.",
                );
            }

            await this.#outside(source.root);
            await unlocked(source);

            if (!(await installed(source.public.executable))) {
                fail("The source browser executable is no longer installed.");
            }

            if ((await metadata(source.root, source.public.path)) !== source.metadata) {
                fail(
                    "Profile metadata changed. Close the source browser first, then discover again.",
                );
            }

            const state = await localState(source.root);
            const entries = await inventory(source.public.path);

            for (const path of [this.#base, this.#imports]) {
                await mkdir(path, { recursive: true, mode: 0o700 });
                await directory(path);
            }

            const destination = join(this.#imports, randomUUID());

            await mkdir(destination, { mode: 0o700 });
            stage = destination;
            const target = join(stage, "Default");

            await mkdir(target, { mode: 0o700 });

            for (const entry of entries) {
                if (entry.stat.isDirectory()) {
                    await mkdir(join(target, entry.name), { mode: 0o700 });
                } else {
                    await copy(source.public.path, target, entry);
                }
            }

            const preferences = join(target, "Preferences");

            if (await stat(preferences)) {
                if ((await lstat(preferences)).size > MAX_STATE) {
                    fail("Profile Preferences are too large.");
                }

                const prefs = JSON.parse(readFileSync(preferences, "utf8"));

                if (!prefs || typeof prefs !== "object" || Array.isArray(prefs)) {
                    fail("Invalid profile Preferences.");
                }

                prefs.session = { ...prefs.session, restore_on_startup: 0, startup_urls: [] };
                prefs.background_mode = { ...prefs.background_mode, enabled: false };
                prefs.sync = {
                    ...prefs.sync,
                    requested: false,
                    has_setup_completed: false,
                    suppress_start: true,
                };
                writeFileSync(preferences, JSON.stringify(prefs), { mode: 0o600 });
            }

            const info = state.json.profile?.info_cache?.[source.public.profile];

            state.json.profile = {
                ...state.json.profile,
                last_used: "Default",
                last_active_profiles: ["Default"],
                info_cache: info ? { Default: info } : {},
            };
            writeFileSync(join(stage, "Local State"), JSON.stringify(state.json), {
                flag: "wx",
                mode: 0o600,
            });
            const after = await inventory(source.public.path);

            if (
                entries.length !== after.length ||
                entries.some(
                    (entry, index) =>
                        entry.name !== after[index]?.name ||
                        stamp(entry.stat) !== stamp(after[index]!.stat),
                ) ||
                (await metadata(source.root, source.public.path)) !== source.metadata
            ) {
                fail("Profile changed during import. Close the source browser first, then retry.");
            }

            await unlocked(source);
            const selected = {
                id: source.public.id,
                label: source.public.label,
                browser: source.public.browser,
                executable: source.public.executable,
                directory: stage,
            };

            this.#save(selected);
            this.#current = selected;
            stage = undefined;

            return { ...selected };
        } catch (error) {
            throw error instanceof BrowserError
                ? error
                : new BrowserError(`Could not import browser profile: ${(error as Error).message}`);
        } finally {
            try {
                if (stage) {
                    rmSync(stage, { recursive: true, force: true });
                }
            } finally {
                this.#busy = false;
            }
        }
    }

    #save(selected: ImportedProfile): void {
        const temporary = join(this.#base, `default-profile-${randomUUID()}.tmp`);

        try {
            writeFileSync(temporary, JSON.stringify(selected), { mode: 0o600, flag: "wx" });
            renameSync(temporary, this.#pointer);
        } finally {
            rmSync(temporary, { force: true });
        }
    }

    useClean(): void {
        if (this.#busy) {
            fail("A browser profile import is already in progress.");
        }

        try {
            mkdirSync(this.#base, { recursive: true, mode: 0o700 });

            if (lstatSync(this.#base).isSymbolicLink()) {
                fail("The app browser directory must not be a symlink.");
            }

            unlinkSync(this.#pointer);
        } catch (error) {
            if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
                throw error instanceof BrowserError
                    ? error
                    : new BrowserError(
                          `Could not select a clean profile: ${(error as Error).message}`,
                      );
            }
        }

        this.#current = undefined;
    }
}
